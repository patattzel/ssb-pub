'use strict'

const { createHash } = require('node:crypto')
const pull = require('pull-stream')
const blobs = require('ssb-blobs')

const maxBlobSize = 5 * 1024 * 1024

module.exports = {
  ...blobs,
  init(peer, config) {
    let downloads = 0
    peer.on('rpc:connect', (rpc) => {
      const get = rpc.blobs.get
      rpc.blobs.get = (options) => pull(
        pull.once(true),
        pull.asyncMap((_start, cb) => {
          if (downloads >= 8) return cb(new Error('Too many active blob downloads'))
          downloads++
          const chunks = []
          let size = 0
          let finished = false
          const hash = createHash('sha256')
          function finish(err) {
            if (finished) return
            finished = true
            clearTimeout(timeout)
            downloads--
            if (err) return cb(err)
            if ('&' + hash.digest('base64') + '.sha256' !== options.key) {
              return cb(new Error('Blob hash did not match the requested ID'))
            }
            cb(null, Buffer.concat(chunks, size))
          }
          const drain = pull.drain((chunk) => chunks.push(chunk), finish)
          const timeout = setTimeout(() => {
            const err = new Error('Blob download timed out')
            drain.abort(err, () => finish(err))
          }, 30_000)
          pull(get(options), pull.asyncMap((chunk, next) => {
            if (!Buffer.isBuffer(chunk) || size + chunk.length >= maxBlobSize) {
              return next(new Error('Invalid or oversized blob'))
            }
            size += chunk.length
            hash.update(chunk)
            next(null, chunk)
          }), drain)
        }),
      )
    })
    const api = blobs.init(peer, config)
    const getSlice = api.getSlice
    api.getSlice = function (options) {
      const { start, end } = options || {}
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        return pull.error(new Error('Invalid blob range'))
      }
      return start === end ? pull.empty() : getSlice.call(this, options)
    }
    return api
  },
}
