'use strict'

const { Server, createWebSocketStream } = require('ws')
const { duplex } = require('stream-to-pull-stream')
const Reader = require('pull-reader')
const WebSocketTransport = require('multiserver/plugins/ws')
const Shs = require('multiserver/plugins/shs')

function pubWebsocket(config) {
  const transport = WebSocketTransport(config)
  if (!config.server) return transport
  return {
    ...transport,
    server(connect, started) {
      const server = new Server({
        server: config.server,
        path: '/',
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
        verifyClient: ({ req }) => req.url === '/' && server.clients.size < 256,
      })
      server.on('connection', (socket, req) => {
        const stream = createWebSocketStream(socket)
        socket.prependListener('message', (message) => {
          if (typeof message === 'string') stream.destroy(new Error('SSB requires binary WebSocket messages'))
        })
        connect({ ...duplex(stream), address: 'ws:' + req.socket.remoteAddress })
      })
      started(null, true)
      return (close) => {
        config.server.close(close)
        server.close()
        for (const socket of server.clients) socket.terminate()
      }
    },
  }
}

function boundedRpc(source, disconnect) {
  const reader = Reader()
  reader(source)
  let body
  function reject(cb, message) {
    // Muxrpc shutdown can wait for a goodbye from the other peer.
    setImmediate(disconnect)
    cb(new Error(message))
  }
  return (abort, cb) => {
    if (abort) return reader.abort(abort, cb)
    if (body) {
      const next = body
      body = null
      return cb(null, next)
    }
    reader.read(9, (err, header) => {
      if (err) return cb(err)
      const size = header.readUInt32BE(1)
      if (size === 0) return cb(null, header)
      if (size > 8 * 1024 * 1024) return reject(cb, 'SSB RPC frame is too large')
      reader.read(size, (err, payload) => {
        if (err) return cb(err)
        // Muxrpc dereferences JSON null before its request error handling.
        if (header.readInt32BE(5) > 0 && (header[0] & 3) === 2 && payload.toString().trim() === 'null') {
          return reject(cb, 'Invalid SSB RPC request')
        }
        body = payload
        cb(null, header)
      })
    })
  }
}

const pubShs = {
  name: 'pubShs',
  version: '1.0.0',
  init(ssb, config) {
    const { public: publicKey, private: secretKey } = config.keys
    const shs = Shs({
      keys: {
        publicKey: Buffer.from(publicKey.split('.')[0], 'base64'),
        secretKey: Buffer.from(secretKey.split('.')[0], 'base64'),
      },
      appKey: config.caps.shs,
      timeout: config.timers.handshake,
      authenticate(publicKey, cb) {
        ssb.auth('@' + publicKey.toString('base64') + '.ed25519', (err, permissions) => {
          cb(err, permissions || true)
        })
      },
    })
    ssb.multiserver.transform({
      name: 'pub-shs',
      create: () => ({
        ...shs,
        create() {
          const transform = shs.create()
          return (stream, cb) => transform(stream, (err, secured) => {
            if (err) return cb(err)
            secured.source = boundedRpc(secured.source, () => stream.source(true, () => {}))
            cb(null, secured)
          })
        },
      }),
    })
  },
}

module.exports = { pubWebsocket, pubShs }
