'use strict'

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { once } = require('node:events')
const { promisify } = require('node:util')
const keys = require('ssb-keys')
const ref = require('ssb-ref')
const createPeer = require('./peer')
const openInvites = require('./invites')
const loadConfig = require('./config')
const openAuth = require('./web/auth')
const pubProfile = require('./web/profile')
const webRoutes = require('./web/routes')

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readClaim(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return null
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return null
  }
}

function isClassicFeed(id) {
  return typeof id === 'string' && id.length === 53 &&
    /^@[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=\.ed25519$/.test(id) &&
    ref.isFeed(id)
}

function loadKeys(dir) {
  const filename = path.join(dir, 'secret')
  try {
    const identity = keys.loadSync(filename)
    if (!isClassicFeed(identity?.id) || identity.id !== '@' + identity.public ||
        typeof identity.private !== 'string') throw new Error('Invalid Pub identity')
    return identity
  } catch (err) {
    if (err.code !== 'ENOENT' || fs.existsSync(path.join(dir, 'db2'))) throw err
    return keys.createSync(filename)
  }
}

async function run() {
  const config = loadConfig()
  process.umask(0o077)
  fs.mkdirSync(config.data, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(config.socket), { recursive: true, mode: 0o700 })
  await clearStaleSocket(config.socket)
  const admin = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 })
  admin.listen(config.socket)
  await once(admin, 'listening')
  fs.chmodSync(config.socket, 0o600)
  const identity = loadKeys(config.data)
  const address = config.transport + '~shs:' + identity.public.slice(0, -8)
  const invites = openInvites(path.join(config.data, 'invites.sqlite'))
  const auth = openAuth(path.join(config.data, 'admin.sqlite'), config, identity.id)
  const postTo = new URL('/claim', config.origin).href
  const inviteURL = (token = invites.create()) => {
    const url = new URL('/invite', config.origin)
    url.searchParams.set('token', token)
    return url.href
  }
  let ready = false
  let shuttingDown = false
  let followQueue = Promise.resolve()
  const pendingFollows = new Map()
  const claimError = (res, error) => json(res, 200, { status: 'error', error })

  const web = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    try {
      const url = new URL(req.url, config.origin)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(ready ? 204 : 503).end()
      } else if (!ready) {
        res.writeHead(503).end()
      } else if (req.method === 'GET' && url.pathname === '/invite') {
        res.setHeader('Referrer-Policy', 'no-referrer')
        const token = url.searchParams.get('token')
        const invite = invites.get(token)
        if (url.searchParams.get('encoding') === 'json') {
          if (!invite) return claimError(res, 'Invitation is invalid or expired')
          return json(res, 200, { status: 'successful', invite: token, postTo })
        }
        routes.invitation(req, res, invite && token, postTo)
      } else if (req.method === 'POST' && url.pathname === '/claim') {
        const body = await readClaim(req)
        if (!isClassicFeed(body?.id) || body.id === identity.id) return claimError(res, 'Invalid SSB feed ID')
        if (!ready) return res.writeHead(503).end()
        if (!invites.claim(body.invite, body.id)) {
          return claimError(res, 'Invitation is invalid, expired or already claimed')
        }
        // Keep a token bound to the first identity across retries and restarts.
        await queueFollow(body.id)
        json(res, 200, { status: 'successful', multiserverAddress: address })
      } else if (!await routes.handle(req, res, url)) {
        res.writeHead(404).end()
      }
    } catch (err) {
      console.error('HTTP request failed:', err.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  admin.on('request', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!ready) return res.writeHead(503).end()
    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, { id: identity.id, address })
    }
    try {
      if (req.method === 'POST' && req.url === '/invite') {
        return json(res, 201, { url: inviteURL() })
      }
      if (req.method === 'POST' && req.url === '/admin') {
        const body = await readClaim(req)
        if (!isClassicFeed(body?.id) || body.id === identity.id) {
          return json(res, 400, { error: 'Use your public Manyverse SSB ID (@….ed25519).' })
        }
        const previous = auth.changeAdmin(body.id)
        if (previous && previous !== body.id) {
          for (const rpc of [...(peer.peers[previous] || [])]) rpc.close(true)
        }
        return json(res, 200, { message: 'Administrator set. Open ' + config.origin.origin + '/admin' })
      }
      if (req.method === 'POST' && req.url === '/password') {
        const body = await readClaim(req)
        if (!ready) return res.writeHead(503).end()
        if (typeof body?.password !== 'string' || body.password.length < 12 || body.password.length > 256) {
          return json(res, 400, { error: 'Use a password of 12 to 256 characters.' })
        }
        if (!await auth.changePassword(body.password)) {
          return json(res, 409, { error: 'Set the administrator first with pubctl admin.' })
        }
        return json(res, 200, { message: 'Admin password set. Existing web sessions were signed out.' })
      }
    } catch (err) {
      console.error('Admin request failed:', err.message)
      return res.writeHead(500).end()
    }
    res.writeHead(404).end()
  })
  web.listen(config.httpPort, config.httpHost)
  await once(web, 'listening')

  const incoming = {
    ws: [{ scope: 'public', transform: 'pub-shs', server: web, external: config.origin.hostname }],
  }
  if (config.tcpListenPort) {
    incoming.net = [{ scope: 'public', transform: 'pub-shs', host: '0.0.0.0', port: config.tcpListenPort }]
  }
  const peer = createPeer({
    path: config.data,
    keys: identity,
    timers: { handshake: 5000, inactivity: 600000 },
    friends: { hops: 1, hookAuth: false },
    conn: { autostart: false },
    connections: { incoming, outgoing: { net: [{ transform: 'shs' }], ws: [{ transform: 'shs' }] } },
  }, { pub: true, adminId: auth.adminId, plugins: [auth.plugin, require('ssb-about-self')] })
  const profile = pubProfile(peer, config.data)
  const routes = webRoutes({ config, auth, profile, peer, address, inviteURL })

  const isFollowing = promisify(peer.friends.isFollowing)
  const isBlocking = promisify(peer.friends.isBlocking)
  const publish = promisify(peer.db.publish)
  const drain = promisify(peer.db.onDrain)

  function queueFollow(id) {
    const pending = pendingFollows.get(id)
    if (pending) return pending
    const result = followQueue.then(() => follow(id)).finally(() => pendingFollows.delete(id))
    followQueue = result.catch(() => {})
    pendingFollows.set(id, result)
    return result
  }

  async function follow(id) {
    const relation = { source: peer.id, dest: id }
    if (await isBlocking(relation)) throw new Error('Feed blocked')
    if (!await isFollowing(relation)) {
      await publish({ type: 'contact', contact: id, following: true, pub: true })
      await drain('contacts')
    }
    peer.ebt.request(id, true)
  }

  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    ready = false
    admin.close()
    auth.stop()
    const deadline = setTimeout(() => process.exit(1), 12_000)
    try {
      await followQueue
      await profile.idle()
      await promisify(peer.close)(true)
      invites.close()
      auth.close()
      clearTimeout(deadline)
      process.exit(0)
    } catch (err) {
      console.error('Shutdown failed:', err.message)
      process.exit(1)
    }
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  const startupTimeout = setTimeout(() => {
    console.error('The SSB listener did not start')
    process.exit(1)
  }, 15_000)
  await once(peer, 'multiserver:listening')
  clearTimeout(startupTimeout)
  await drain('contacts')
  await drain('aboutSelf')
  if (shuttingDown) return
  await profile.migrateImage().catch((err) => {
    console.error('Profile image migration failed:', err.message)
  })
  if (shuttingDown) return
  ready = true
  console.log('SSB Pub ready at', address)
}

function clearStaleSocket(socket) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket)
    conn.once('connect', () => {
      conn.destroy()
      reject(new Error('Pub already running on the admin socket'))
    })
    conn.once('error', (err) => {
      if (err.code === 'ENOENT') return resolve()
      if (err.code === 'ECONNREFUSED') {
        try {
          const file = fs.lstatSync(socket, { throwIfNoEntry: false })
          if (file && !file.isSocket()) return reject(err)
          if (file) fs.unlinkSync(socket)
          return resolve()
        } catch (error) {
          if (error.code === 'ENOENT') return resolve()
          return reject(error)
        }
      }
      reject(err)
    })
  })
}

run().catch((err) => {
  console.error('Pub startup failed:', err.message)
  process.exit(1)
})
