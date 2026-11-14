'use strict'

const { createHash, randomBytes } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const lifetime = 7 * 24 * 60 * 60 * 1000
const isToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
const hash = (token) => createHash('sha256').update(token).digest('hex')

module.exports = function openInvites(filename) {
  const db = new DatabaseSync(filename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      expires INTEGER NOT NULL,
      feed TEXT
    ) STRICT
  `)
  const insert = db.prepare('INSERT INTO invites VALUES (?, ?, NULL)')
  const removeOld = db.prepare('DELETE FROM invites WHERE expires <= ?')
  const get = db.prepare('SELECT feed FROM invites WHERE token_hash = ? AND expires > ?')
  const bind = db.prepare('UPDATE invites SET feed = ? WHERE token_hash = ? AND feed IS NULL')
  const lookup = (token) => isToken(token) ? get.get(hash(token), Date.now()) : undefined
  return {
    create() {
      const now = Date.now()
      removeOld.run(now)
      const token = randomBytes(32).toString('base64url')
      insert.run(hash(token), now + lifetime)
      return token
    },
    get: lookup,
    claim(token, feed) {
      const invite = lookup(token)
      if (!invite || (invite.feed && invite.feed !== feed)) return false
      if (invite.feed) return true
      return bind.run(feed, hash(token)).changes === 1
    },
    close() {
      db.close()
    },
  }
}
