'use strict'

const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const websocket = require('multiserver/plugins/ws')
const pull = require('pull-stream')
const { pubWebsocket, pubShs } = require('./transport')

const pubAccess = {
  name: 'pubAccess',
  version: '1.0.0',
  init(ssb, options) {
    ssb.auth.hook(function (next, [id, cb]) {
      if (id === ssb.id) return next.call(this, id, cb)
      const peer = { source: ssb.id, dest: id }
      ssb.friends.isFollowing(peer, (err, following) => {
        if (err) return cb(err)
        if (!following) {
          if (options.adminId?.() === id) {
            return cb(null, { allow: ['manifest', 'httpAuth.sendSolution', 'httpAuth.invalidateAllSolutions'] })
          }
          return cb(new Error('An invitation is required'))
        }
        ssb.friends.isBlocking(peer, (error, blocked) => {
          if (error || blocked) return cb(error || new Error('Peer is blocked'))
          cb(null, null)
        })
      })
    })
  },
}

const pubReplication = {
  name: 'pubReplication',
  version: '1.0.0',
  init(ssb) {
    ssb.ebt.request(ssb.id, true)
    // A pub can serve its members' feeds without traversing their follow graphs.
    pull(ssb.friends.graphStream({ old: true, live: true }), pull.drain((graph) => {
      for (const [feed, state] of Object.entries(graph[ssb.id] || {})) {
        if (feed === ssb.id) continue
        ssb.ebt.request(feed, state >= 0)
        ssb.ebt.block(ssb.id, feed, state === -1)
      }
    }))
  },
}

// The classic feed, blob store and EBT components are the same as in Manyverse.
module.exports = function createPeer(options, { pub = false, adminId, plugins = [] } = {}) {
  const stack = SecretStack({ caps })
    .use(require('ssb-master'))
    .use(require('ssb-db2'))
    .use(require('ssb-db2/compat/db'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-db2/compat/history-stream'))
    .use(require('ssb-friends'))
    .use(require('ssb-ebt'))
    .use(require('ssb-conn'))
    .use(pub ? require('./blobs') : require('ssb-blobs'))
    .use({
      name: 'websocketTransport',
      version: '1.0.0',
      init(ssb) {
        ssb.multiserver.transport({ name: 'ws', create: pub ? pubWebsocket : websocket })
      },
    })

  if (pub) stack.use(pubShs).use(pubAccess).use(pubReplication)
  for (const plugin of plugins) stack.use(plugin)
  return stack({ ...options, adminId })
}
