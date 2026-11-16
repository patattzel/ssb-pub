'use strict'

const { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } = require('node:crypto')
const { isIP } = require('node:net')
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

function challengeTime(sc, now) {
  if (!validNonce(sc)) return null
  const bytes = Buffer.from(sc, 'base64')
  const timestamp = bytes.readUIntBE(0, 6)
  if (sc !== bytes.toString('base64') || timestamp > now || timestamp + challengeLifetime <= now) return null
  return bytes.subarray(0, 10)
}

function clientAddress(req, proxyIP) {
  const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '')
  if (proxyIP && remote === proxyIP) {
    const forwarded = req.headers['x-forwarded-for']?.split(',').pop().trim()
    if (isIP(forwarded)) return forwarded.replace(/^::ffff:/, '')
  }
  return remote
}

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
    CREATE TABLE IF NOT EXISTS used_client_nonces (
      hash TEXT PRIMARY KEY
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
  const usedClientNonce = db.prepare('SELECT 1 FROM used_client_nonces WHERE hash = ?')
  const useClientNonce = db.prepare('INSERT OR IGNORE INTO used_client_nonces VALUES (?)')
  const pendingClientNonces = new Set()
  const approvals = new Map()
  const events = new AbortController()
  const secure = config.origin.protocol === 'https:'
  const sessionName = secure ? '__Host-ssb-pub' : 'ssb-pub'
  const browserName = secure ? '__Host-ssb-pub-login' : 'ssb-pub-login'
  let challengeKey = randomBytes(32)
  let windowStart = 0
  let passwordChecks = 0
  const attempts = new Map()

  function challenge(browser, timestamp) {
    const tag = createHmac('sha256', challengeKey).update(timestamp).update(browser).digest().subarray(0, 22)
    return Buffer.concat([timestamp, tag]).toString('base64')
  }

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
    challengeKey = randomBytes(32)
    approvals.clear()
    attempts.clear()
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
    async checkPassword(req, password) {
      const record = lookup.get()
      if (!record?.password || typeof password !== 'string' || password.length > 256) return false
      const now = Date.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        attempts.clear()
      }
      const source = clientAddress(req, config.proxyIP)
      const count = attempts.get(source) || 0
      if (count >= 12 || passwordChecks >= 4 || (!count && attempts.size >= 4096)) return false
      attempts.set(source, count + 1)
      passwordChecks++
      let value
      try {
        value = await derive(password, record.salt, 64)
      } finally {
        passwordChecks--
      }
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
      const browser = cookie(req, browserName) || opaque()
      setCookie(res, browserName, browser, challengeLifetime)
      const timestamp = randomBytes(10)
      timestamp.writeUIntBE(Date.now(), 0, 6)
      return challenge(browser, timestamp)
    },
    browserChallenge(req, sc) {
      const browser = cookie(req, browserName)
      const timestamp = challengeTime(sc, Date.now())
      if (!browser || !timestamp || !timingSafeEqual(Buffer.from(sc), Buffer.from(challenge(browser, timestamp)))) return null
      return approvals.get(sc)?.state ?? 'waiting'
    },
    complete(req, sc) {
      if (this.browserChallenge(req, sc) !== 'approved') return false
      approvals.get(sc).state = 'used'
      return true
    },
    async fromClient(peer, cid, cc) {
      if (!validNonce(cc) || cc !== Buffer.from(cc, 'base64').toString('base64') || cid !== this.adminId()) return false
      const nonceHash = digest(cc)
      if (pendingClientNonces.size >= 16 || pendingClientNonces.has(nonceHash) || usedClientNonce.get(nonceHash)) return false
      const rpc = peer.peers[cid]?.find((connection) => !connection.closed)
      if (!rpc) return false
      const sc = nonce()
      const currentKey = challengeKey
      pendingClientNonces.add(nonceHash)
      try {
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
        return !events.signal.aborted && currentKey === challengeKey && cid === this.adminId() &&
          verify(sid, cid, sc, cc, signature) && useClientNonce.run(nonceHash).changes === 1
      } finally {
        pendingClientNonces.delete(nonceHash)
      }
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
            const now = Date.now()
            const timestamp = challengeTime(sc, now)
            if (!timestamp || approvals.has(sc) ||
                this.id !== lookup.get()?.feed || !validNonce(cc) ||
                !verify(sid, this.id, sc, cc, signature)) {
              return cb(new Error('Invalid or expired administrator login'))
            }
            for (const [nonce, approval] of approvals) {
              if (approval.expires <= now) approvals.delete(nonce)
            }
            if (approvals.size >= 1024) return cb(new Error('Too many approved logins'))
            approvals.set(sc, { expires: timestamp.readUIntBE(0, 6) + challengeLifetime, state: 'approved' })
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
