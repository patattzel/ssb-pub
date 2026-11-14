'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const QRCode = require('qrcode')
const views = require('./views')

const assets = new Map([
  ['/assets/pub.css', ['text/css; charset=utf-8', fs.readFileSync(path.join(__dirname, 'pub.css'))]],
  ['/assets/pub.js', ['text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, 'pub.js'))]],
  ['/assets/dm-sans.woff2', ['font/woff2', fs.readFileSync(path.join(__dirname, 'dm-sans.woff2'))]],
  ['/assets/icon.png', ['image/png', fs.readFileSync(path.join(__dirname, '../assets/icon.png'))]],
])

function html(res, page, status = page.status) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page.html)
}

function redirect(res, location) {
  res.writeHead(303, { Location: location }).end()
}

function ssbURI(query, userAgent) {
  const params = new URLSearchParams(query)
  if (/Android/i.test(userAgent || '') && /Chrome\//i.test(userAgent)) {
    return `intent://experimental?${params}#Intent;scheme=ssb;end;`
  }
  return `ssb:experimental?${params}`
}

async function form(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    return new URLSearchParams()
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) return new URLSearchParams()
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString())
}

async function streamEvents(req, res, auth, challenge) {
  if (!auth.browserChallenge(req, challenge)) return res.writeHead(403).end()
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' })
  res.write(': waiting\n\n')
  const closed = new AbortController()
  res.once('close', () => closed.abort())
  const signal = AbortSignal.any([closed.signal, auth.signal])
  let heartbeat = Date.now()
  try {
    while (!signal.aborted) {
      const item = auth.browserChallenge(req, challenge)
      if (!item || item.signed) {
        res.end(`event: ${item ? 'approved' : 'expired'}\ndata: 1\n\n`)
        return
      }
      if (Date.now() - heartbeat > 10_000) {
        res.write(': waiting\n\n')
        heartbeat = Date.now()
      }
      await sleep(400, undefined, { signal })
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err
  } finally {
    res.end()
  }
}

module.exports = function webRoutes({ config, auth, profile, peer, address, inviteURL }) {
  function dashboard(res, options = {}) {
    html(res, views.dashboard(profile.get(), { feed: peer.id, address, ...options }))
  }

  async function login(req, res, url, error, status) {
    const active = Boolean(auth.adminId())
    const remote = url?.searchParams.has('sc') || false
    const sc = active && (remote ? url.searchParams.get('sc') : auth.newChallenge(req, res))
    let link, qr
    if (sc && /^[A-Za-z0-9+/]{43}=$/.test(sc)) {
      link = ssbURI({
        action: 'start-http-auth', sid: peer.id, sc, multiserverAddress: address,
      }, req.headers['user-agent'])
      if (!remote && config.origin.protocol === 'https:') {
        const phone = new URL('/login', config.origin)
        phone.searchParams.set('ssb-http-auth', '1')
        phone.searchParams.set('sc', sc)
        qr = await QRCode.toDataURL(phone.href, { width: 180, margin: 2 })
      }
    }
    html(res, views.login(profile.get(), {
      active, hasPassword: auth.hasPassword(), adminId: auth.adminId(), link, qr, sc, remote, error,
    }), status)
  }

  return {
    invitation(req, res, token, postTo) {
      html(res, views.publicPage(profile.get(), token ? {
        invite: inviteURL(token),
        app: ssbURI({ action: 'claim-http-invite', invite: token, postTo }, req.headers['user-agent']),
      } : { unavailable: true }))
    },
    async handle(req, res, url) {
      const route = req.method + ' ' + url.pathname
      if (req.method === 'POST' && req.headers.origin !== config.origin.origin) {
        res.writeHead(403).end()
        return true
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [type, body] = assets.get(url.pathname)
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' }).end(body)
        return true
      }
      if (req.method === 'GET' && /^\/profile-image\/[a-f0-9]{64}$/.test(url.pathname)) {
        const image = profile.readImage(url.pathname.split('/').pop())
        if (image) res.writeHead(200, { 'Content-Type': image.type }).end(image.data)
        else res.writeHead(404).end()
        return true
      }
      if (url.pathname.startsWith('/admin') && !auth.authenticated(req)) {
        if (req.method === 'GET') redirect(res, '/login?ssb-http-auth=1')
        else res.writeHead(403).end()
        return true
      }
      switch (route) {
        case 'GET /':
          html(res, views.publicPage(profile.get()))
          break
        case 'GET /login': {
          if (auth.authenticated(req)) {
            redirect(res, '/admin')
            break
          }
          const cc = url.searchParams.get('cc')
          const cid = url.searchParams.get('cid')
          if (cc || cid) {
            if (!await auth.fromClient(peer, cid, cc)) {
              await login(req, res, null, 'Manyverse could not verify this sign-in.', 403)
              break
            }
            auth.signIn(res)
            redirect(res, '/admin')
            break
          }
          await login(req, res, url)
          break
        }
        case 'GET /login/events':
          await streamEvents(req, res, auth, url.searchParams.get('sc'))
          break
        case 'POST /login/complete': {
          const values = await form(req)
          if (!auth.complete(req, values.get('sc'))) {
            await login(req, res, null, 'This sign-in has expired or belongs to another browser.', 403)
            break
          }
          auth.signIn(res)
          redirect(res, '/admin')
          break
        }
        case 'POST /login/password': {
          const values = await form(req)
          if (!await auth.checkPassword(values.get('password'))) {
            await login(req, res, null, 'Unable to sign in. Check the password or retry shortly.', 403)
            break
          }
          auth.signIn(res)
          redirect(res, '/admin')
          break
        }
        case 'POST /logout':
          auth.signOut(req, res)
          redirect(res, '/')
          break
        case 'GET /admin':
          dashboard(res, { saved: url.searchParams.has('saved') })
          break
        case 'POST /admin/profile':
          try {
            await profile.update(req, () => auth.authenticated(req) && !auth.signal.aborted)
            redirect(res, '/admin?saved=1')
          } catch (err) {
            console.error('Profile update failed:', err.message)
            dashboard(res, { error: 'Could not save the profile. Check the name, description and image, then retry.' })
          }
          break
        case 'POST /admin/invite':
          dashboard(res, { invite: inviteURL() })
          break
        default:
          return false
      }
      return true
    },
  }
}
