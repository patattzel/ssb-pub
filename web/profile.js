'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { createHash } = require('node:crypto')
const pull = require('pull-stream')
const Busboy = require('busboy')
const sharp = require('sharp')

const icon = fs.readFileSync(path.join(__dirname, '../assets/icon.png'))
const imageLimit = 4 * 1024 * 1024
const defaultDescription = 'This Scuttlebutt pub keeps feeds available for invited peers, even when their authors are offline.'

function encodeImage(input) {
  return input.rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).png().toBuffer()
}

async function readProfile(req) {
  const values = Object.create(null)
  const chunks = []
  const parser = Busboy({ headers: req.headers, limits: {
    files: 1, fileSize: imageLimit + 1, fields: 3, fieldSize: 4096, parts: 5,
  } })
  const received = await new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    let total = 0
    const meter = (chunk) => {
      total += chunk.length
      if (total > imageLimit + 16_384) {
        req.unpipe(parser)
        req.removeListener('data', meter)
        parser.destroy()
        req.resume()
        reject(new Error('Upload is too large'))
      }
    }
    const limits = () => { overflow = true }
    parser.on('filesLimit', limits).on('fieldsLimit', limits).on('partsLimit', limits)
    parser.on('field', (key, value, info) => {
      if (info.valueTruncated) limits()
      values[key] = value
    })
    parser.on('file', (_key, stream) => {
      stream.on('limit', limits).on('error', reject).on('data', (chunk) => {
        size += chunk.length
        if (size <= imageLimit) chunks.push(chunk)
        else limits()
      })
    })
    parser.on('error', reject)
    parser.on('close', () => {
      req.removeListener('data', meter)
      if (overflow) reject(new Error('Image or form is too large'))
      else resolve(size)
    })
    req.on('error', reject).on('aborted', () => reject(new Error('Upload interrupted')))
    req.on('data', meter)
    req.pipe(parser)
  })
  const name = values.name?.trim()
  const description = values.description?.trim() || ''
  if (!name || name.length > 80 || description.length > 1200) throw new Error('Invalid profile text')
  let image
  if (received || values.reset === 'yes') {
    const input = sharp(received ? Buffer.concat(chunks) : icon, {
      limitInputPixels: 16_000_000, failOn: 'error',
    })
    const { format } = await input.metadata()
    if (!['jpeg', 'png', 'webp'].includes(format)) throw new Error('Use a JPEG, PNG or WebP image')
    image = await encodeImage(input)
  }
  return { name, description, image }
}

module.exports = function pubProfile(peer, data) {
  const images = path.join(data, 'profile-images')
  fs.mkdirSync(images, { recursive: true, mode: 0o700 })
  const get = () => {
    const profile = peer.db.getIndex('aboutSelf').getProfile(peer.id)
    const image = profile.image && /^&[A-Za-z0-9+/]{43}=\.sha256$/.test(profile.image)
      ? Buffer.from(profile.image.slice(1, -7), 'base64').toString('hex') : null
    return {
      name: profile.name || 'SSB Pub',
      description: profile.description ?? defaultDescription,
      image,
    }
  }
  function readStoredImage(id) {
    for (const format of ['png', 'webp']) {
      try {
        const data = fs.readFileSync(path.join(images, id + '.' + format))
        return { data, type: 'image/' + format }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    return null
  }

  async function publish({ name, description, image }, authorize) {
    if (!authorize()) throw new Error('Session expired')
    const content = { type: 'about', about: peer.id, name, description }
    if (image) {
      const imageHash = createHash('sha256').update(image).digest('hex')
      content.image = await new Promise((resolve, reject) => {
        pull(pull.values([image]), peer.blobs.add((err, id) => err ? reject(err) : resolve(id)))
      })
      const filename = path.join(images, imageHash + '.png')
      const temporary = filename + '.tmp'
      fs.writeFileSync(temporary, image)
      fs.renameSync(temporary, filename)
    }
    if (!authorize()) throw new Error('Session expired')
    await promisify(peer.db.publish)(content)
    await promisify(peer.db.onDrain)('aboutSelf')
  }

  let queue = Promise.resolve()
  function enqueue(task) {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }

  return {
    get,
    idle: () => queue,
    readImage(id) {
      return id === get().image ? readStoredImage(id) : null
    },
    migrateImage() {
      return enqueue(async () => {
        const { name, description, image } = get()
        const stored = image && readStoredImage(image)
        if (stored?.type !== 'image/webp') return
        const png = await encodeImage(sharp(stored.data, { limitInputPixels: 512 * 512 }))
        await publish({ name, description, image: png }, () => true)
      })
    },
    async update(req, authorize) {
      const values = await readProfile(req)
      return enqueue(() => publish(values, authorize))
    },
  }
}
