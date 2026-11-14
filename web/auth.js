'use strict'

const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto')
const { promisify } = require('node:util')
const { DatabaseSync } = require('node:sqlite')
const keys = require('ssb-keys')

const derive = promisify(scrypt)
const challengeLifetime = 3 * 60 * 1000
const sessionLifetime = 12 * 60 * 60 * 1000
const opaque = () => randomBytes(32).toString('base64url')
const nonce = () => randomBytes(32).toString('base64')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const validNonce = (value) => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

function verify(sid, cid, sc, cc, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==\.sig\.ed25519$/.test(signature)) return false
  return keys.verify(cid.slice(1), signature, `=http-auth-sign-in:${sid}:${cid}:${sc}:${cc}`)
}

module.exports = function openAuth(filename, config, sid) {
  const db = new DatabaseSync(filename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin (
      row INTEGER PRIMARY KEY CHECK (row = 1),
      feed TEXT NOT NULL,
      salt TEXT,
      password TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY,
      expires INTEGER NOT NULL
    ) STRICT;
  `)
  const lookup = db.prepare('SELECT feed, salt, password FROM admin WHERE row = 1')
  const setAdmin = db.prepare('INSERT INTO admin VALUES (1, ?, NULL, NULL) ON CONFLICT(row) DO UPDATE SET feed = excluded.feed, salt = NULL, password = NULL')
  const setPassword = db.prepare('UPDATE admin SET salt = ?, password = ? WHERE row = 1 AND feed = ?')
  const insertSession = db.prepare('INSERT INTO sessions VALUES (?, ?)')
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires > ?')
  const removeSession = db.prepare('DELETE FROM sessions WHERE hash = ?')
  const pruneSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?')
  const deleteSessions = db.prepare('DELETE FROM sessions')
  const challenges = new Map()
  const events = new AbortController()
  const secure = config.origin.protocol === 'https:'
  const sessionName = secure ? '__Host-ssb-pub' : 'ssb-pub'
  const browserName = secure ? '__Host-ssb-pub-login' : 'ssb-pub-login'
  let windowStart = 0
  let attempts = 0

  function cookie(req, name) {
    for (const entry of (req.headers.cookie || '').split(';')) {
      const value = entry.trim()
      if (value.startsWith(name + '=')) {
        const token = value.slice(name.length + 1)
        return validToken(token) ? token : null
      }
    }
    return null
  }

  function setCookie(res, name, token, duration) {
    res.appendHeader('Set-Cookie',
      `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${duration / 1000}${secure ? '; Secure' : ''}`)
  }

  function invalidate() {
    deleteSessions.run()
    challenges.clear()
  }

  function saveCredentials(fn) {
    db.exec('BEGIN')
    try {
      const result = fn()
      if (result) invalidate()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  return {
    adminId() {
      return lookup.get()?.feed
    },
    changeAdmin(id) {
      const previous = lookup.get()?.feed
      if (previous !== id) saveCredentials(() => setAdmin.run(id))
      return previous
    },
    async changePassword(password) {
      const record = lookup.get()
      if (!record) return false
      const salt = opaque()
      const value = await derive(password, salt, 64)
      if (events.signal.aborted) return false
      return saveCredentials(() => setPassword.run(salt, value.toString('hex'), record.feed).changes === 1)
    },
    hasPassword() {
      return Boolean(lookup.get()?.password)
    },
    async checkPassword(password) {
      const record = lookup.get()
      if (!record?.password || typeof password !== 'string' || password.length > 256) return false
      const now = Date.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        attempts = 0
      }
      if (attempts >= 12) return false
      attempts++
      const value = await derive(password, record.salt, 64)
      if (events.signal.aborted) return false
      const current = lookup.get()
      const valid = current?.feed === record.feed && current.password === record.password &&
        timingSafeEqual(value, Buffer.from(record.password, 'hex'))
      return valid ? record.feed : false
    },
    authenticated(req) {
      const token = cookie(req, sessionName)
      return Boolean(token && sessionExists.get(digest(token), Date.now()))
    },
    signIn(res) {
      pruneSessions.run(Date.now())
      const token = opaque()
      insertSession.run(digest(token), Date.now() + sessionLifetime)
      setCookie(res, sessionName, token, sessionLifetime)
    },
    signOut(req, res) {
      const token = cookie(req, sessionName)
      if (token) removeSession.run(digest(token))
      setCookie(res, sessionName, '', 0)
    },
    newChallenge(req, res) {
      const now = Date.now()
      for (const [sc, item] of challenges) {
        if (item.expires <= now) challenges.delete(sc)
      }
      if (challenges.size >= 1024) return null
      const browser = cookie(req, browserName) || opaque()
      setCookie(res, browserName, browser, challengeLifetime)
      const sc = nonce()
      challenges.set(sc, { browser: digest(browser), expires: now + challengeLifetime })
      return sc
    },
    browserChallenge(req, sc) {
      const browser = cookie(req, browserName)
      const item = challenges.get(sc)
      if (!browser || !item || item.expires <= Date.now() || digest(browser) !== item.browser) return null
      return item
    },
    complete(req, sc) {
      const item = this.browserChallenge(req, sc)
      if (!item?.signed || item.signed !== this.adminId()) return false
      challenges.delete(sc)
      return true
    },
    async fromClient(peer, cid, cc) {
      if (!validNonce(cc) || cid !== this.adminId()) return false
      const rpc = peer.peers[cid]?.find((connection) => !connection.closed)
      if (!rpc) return false
      const sc = nonce()
      const signature = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 8000)
        try {
          rpc.httpAuth.requestSolution(sc, cc, (err, value) => {
            clearTimeout(timeout)
            resolve(err ? null : value)
          })
        } catch {
          clearTimeout(timeout)
          resolve(null)
        }
      })
      return !events.signal.aborted && cid === this.adminId() && verify(sid, cid, sc, cc, signature)
    },
    signal: events.signal,
    stop() {
      events.abort()
    },
    close() {
      db.close()
    },
    plugin: {
      name: 'httpAuth',
      version: '1.0.0',
      manifest: { sendSolution: 'async', requestSolution: 'async', invalidateAllSolutions: 'async' },
      permissions: { anonymous: { allow: ['sendSolution', 'invalidateAllSolutions'] } },
      init() {
        return {
          sendSolution(sc, cc, signature, cb) {
            const item = typeof sc === 'string' && challenges.get(sc)
            if (!item || item.expires <= Date.now() || item.signed ||
                this.id !== lookup.get()?.feed || !validNonce(cc) ||
                !verify(sid, this.id, sc, cc, signature)) {
              return cb(new Error('Invalid or expired administrator login'))
            }
            item.signed = this.id
            cb(null, true)
          },
          requestSolution(_sc, _cc, cb) {
            cb(new Error('An administrator must sign in from the client'))
          },
          invalidateAllSolutions(cb) {
            if (this.id !== lookup.get()?.feed) return cb(new Error('Administrator required'))
            invalidate()
            cb(null, true)
          },
        }
      },
    },
  }
}
