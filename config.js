'use strict'

const path = require('node:path')
const { isIP } = require('node:net')

function port(value, name) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || number < 1 || number > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535`)
  }
  return number
}

module.exports = function config(env = process.env) {
  const cloudron = Boolean(env.CLOUDRON)
  if (cloudron && !env.CLOUDRON_APP_DOMAIN) throw new Error('Missing CLOUDRON_APP_DOMAIN')
  const publicURL = cloudron ? `https://${env.CLOUDRON_APP_DOMAIN}` :
    env.PUB_URL || 'http://127.0.0.1:3000'
  const origin = new URL(publicURL)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback && !cloudron)) ||
      origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('PUB_URL must be a public HTTPS origin or a local HTTP origin')
  }

  const tcpPort = env.SSB_PORT ? port(env.SSB_PORT, 'SSB_PORT') : null
  if (tcpPort && isIP(origin.hostname.slice(1, -1)) === 6) {
    throw new Error('Use a DNS hostname or IPv4 address for TCP invites')
  }
  const transport = tcpPort
    ? `net:${origin.hostname}:${tcpPort}`
    : `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}`

  const data = cloudron ? '/app/data/ssb-pub' : path.resolve(env.PUB_DATA_DIR || './data')
  const proxyIP = cloudron ? env.CLOUDRON_PROXY_IP : env.PUB_TRUSTED_PROXY
  if (proxyIP && !isIP(proxyIP)) throw new Error('The trusted reverse proxy must be an IP address')
  return {
    origin,
    transport,
    data,
    proxyIP: proxyIP?.replace(/^::ffff:/, ''),
    socket: cloudron ? '/run/ssb-pub/admin.sock' :
      env.PUB_ADMIN_SOCKET || path.join(data, 'admin.sock'),
    httpHost: env.PUB_HTTP_HOST || '127.0.0.1',
    httpPort: port(env.PUB_HTTP_PORT || '3000', 'PUB_HTTP_PORT'),
    tcpListenPort: tcpPort ? port(env.PUB_TCP_LISTEN_PORT || String(tcpPort), 'PUB_TCP_LISTEN_PORT') : null,
  }
}
