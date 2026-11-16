'use strict'

const assert = require('node:assert/strict')
const { spawn, execFile } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp, rm } = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { promisify } = require('node:util')
const test = require('node:test')
const keys = require('ssb-keys')
const pull = require('pull-stream')
const MultiServer = require('multiserver')
const WebSocket = require('ws')
const createPeer = require('../peer')

const exec = promisify(execFile)
const call = (fn, ...args) => new Promise((resolve, reject) => {
  fn(...args, (err, result) => err ? reject(err) : resolve(result))
})
const collect = (source) => call((cb) => pull(source, pull.collect(cb)))

async function sendMalformedRpc(address, identity, { stream = false, length } = {}) {
  const transport = address.startsWith('net:')
    ? require('multiserver/plugins/net')({ scope: 'public' })
    : require('multiserver/plugins/ws')({ scope: 'public' })
  const shs = require('multiserver/plugins/shs')({
    keys: {
      publicKey: Buffer.from(identity.public.split('.')[0], 'base64'),
      secretKey: Buffer.from(identity.private.split('.')[0], 'base64'),
    },
    appKey: require('ssb-caps').shs,
    timeout: 5000,
  })
  const client = MultiServer([[transport, shs]])
  const connection = await call(client.client, address)
  const payload = Buffer.from(' null ')
  const header = Buffer.alloc(9)
  header[0] = stream ? 0b1010 : 0b0010
  header.writeUInt32BE(length ?? payload.length, 1)
  header.writeInt32BE(1, 5)
  const input = Buffer.concat(length ? [header] : [header, payload])
  let pending
  const read = (abort, cb) => {
    if (abort) {
      if (pending) pending(abort)
      cb(abort)
    } else if (pending === undefined) {
      pending = null
      cb(null, input)
    } else {
      pending = cb
    }
  }
  const ended = new Promise((resolve) => pull(connection.source, pull.drain(() => {}, resolve)))
  pull(read, connection.sink)
  const timedOut = Symbol('timed out')
  const result = await Promise.race([ended, sleep(2000, timedOut, { ref: false })])
  if (result === timedOut) connection.source(true, () => {})
  assert.notEqual(result, timedOut, 'Malformed RPC did not disconnect: ' + JSON.stringify({ stream, length }))
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await call(server.close.bind(server))
  return port
}

async function until(check, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await check().catch(() => null)
    if (result) return result
    await sleep(100)
  }
  assert.fail('Timed out waiting for ' + description)
}

for (const tcp of [false, true]) {
  test(`invitation and store-and-forward over ${tcp ? 'TCP' : 'WebSocket'}`,
    { timeout: 60000 }, async (t) => {
      const temp = await mkdtemp(path.join(os.tmpdir(), 'ssb-pub-test-'))
      const source = path.join(__dirname, '..')
      const port = await freePort()
      const origin = `http://127.0.0.1:${port}`
      const tcpPort = tcp ? String(await freePort()) : ''
      const env = {
        ...process.env,
        PUB_URL: origin,
        PUB_HTTP_HOST: '127.0.0.1',
        PUB_HTTP_PORT: String(port),
        PUB_DATA_DIR: path.join(temp, 'pub'),
        PUB_ADMIN_SOCKET: path.join(temp, 'admin.sock'),
        PUB_TRUSTED_PROXY: '127.0.0.1',
        SSB_PORT: tcpPort,
        PUB_TCP_LISTEN_PORT: tcpPort,
        CLOUDRON: '',
      }
      let daemon
      const activePeers = new Set()

      async function start() {
        daemon = spawn(process.execPath, ['server.js'], { cwd: source, env })
        let logs = ''
        daemon.stdout.on('data', (chunk) => { logs += chunk })
        daemon.stderr.on('data', (chunk) => { logs += chunk })
        try {
          await until(async () => (await fetch(origin + '/healthz')).status === 204, 'health check')
        } catch (err) {
          throw new Error(logs, { cause: err })
        }
      }

      async function stop() {
        if (daemon.exitCode !== null || daemon.signalCode) return
        const finished = once(daemon, 'exit')
        daemon.kill('SIGTERM')
        assert.deepEqual(await finished, [0, null])
      }

      const pubctl = async (...args) => (await exec(process.execPath, ['pubctl.js', ...args],
        { cwd: source, env })).stdout.trim()

      async function setPassword(password) {
        return new Promise((resolve, reject) => {
          const request = http.request({
            socketPath: env.PUB_ADMIN_SOCKET, path: '/password', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode))
          })
          request.on('error', reject)
          request.end(JSON.stringify({ password }))
        })
      }

      async function client(name) {
        const peer = createPeer({
          path: path.join(temp, name),
          keys: keys.generate(),
          timers: { inactivity: 60000 },
          friends: { hops: 2, hookAuth: false },
          conn: { autostart: false },
          replicationScheduler: { autostart: true, partialReplication: null },
          connections: {
            incoming: { net: [{ scope: 'device', transform: 'shs', host: '127.0.0.1', port: await freePort() }] },
            outgoing: { net: [{ transform: 'shs' }], ws: [{ transform: 'shs' }] },
          },
        }, { plugins: [
          require('ssb-replication-scheduler'),
          require('ssb-http-invite-client'),
          require('ssb-http-auth-client'),
          require('ssb-about-self'),
        ] })
        activePeers.add(peer)
        await once(peer, 'multiserver:listening')
        return peer
      }

      async function closePeer(peer) {
        await call(peer.close, true)
        activePeers.delete(peer)
      }

      t.after(async () => {
        for (const peer of activePeers) await closePeer(peer)
        if (daemon) await stop()
        await rm(temp, { recursive: true, force: true })
      })

      await start()
      const status = await pubctl('status')
      const address = status.split('\n')[1]
      const alice = await client('alice')
      await assert.rejects(call(alice.connect, address))
      let admin
      let appLoginURL
      if (!tcp) {
        for (const data of ['text frame', Buffer.alloc(1024 * 1024 + 1)]) {
          const socket = new WebSocket(address.split('~')[0])
          await once(socket, 'open')
          const closed = once(socket, 'close')
          socket.send(data)
          await closed
          assert.equal((await fetch(origin + '/healthz')).status, 204)
        }
        admin = await client('admin')
        await pubctl('admin', admin.id)
        const initial = await fetch(origin + '/admin', { redirect: 'manual' })
        assert.equal(initial.status, 303)
        for (let i = 0; i < 33; i++) {
          await Promise.all(Array.from({ length: 32 }, async () => {
            const response = await fetch(origin + '/login')
            await response.arrayBuffer()
          }))
        }
        const login = await fetch(origin + initial.headers.get('location'))
        const browser = login.headers.get('set-cookie').split(';')[0]
        const markup = await login.text()
        const uri = markup.match(/href="(ssb:experimental[^"]+)"/)[1].replaceAll('&amp;', '&')
        const sc = new URL(uri).searchParams.get('sc')
        const approvalURL = origin + '/login/status?' + new URLSearchParams({ sc })
        const checkApproval = () => fetch(approvalURL, { headers: { cookie: browser } })
        assert.equal((await fetch(approvalURL)).status, 403)
        assert.equal((await checkApproval()).status, 204)
        assert.equal(await call(admin.httpAuthClient.consumeSignInSsbUri, uri), true)
        assert.equal((await checkApproval()).status, 200)
        const post = (pathname, cookie, body, requestOrigin = origin, headers = {}) => fetch(origin + pathname, {
          method: 'POST', body, redirect: 'manual',
          headers: { origin: requestOrigin, ...(cookie && { cookie }), ...headers },
        })
        const finish = () => new URLSearchParams({ sc })
        assert.equal((await post('/login/complete', null, finish())).status, 403)
        const signedIn = await post('/login/complete', browser, finish())
        assert.equal(signedIn.status, 303)
        const session = signedIn.headers.get('set-cookie').split(';')[0]
        assert.equal((await checkApproval()).status, 403)
        assert.equal((await post('/login/complete', browser, finish())).status, 403)
        assert.equal((await post('/admin/invite', session, null, 'https://other.example')).status, 403)
        const adminPanel = await fetch(origin + '/admin', { headers: { cookie: session } })
        assert.match(await adminPanel.text(), /Pub settings/)

        const cc = admin.httpAuthClientTokens.create()
        appLoginURL = origin + '/login?' + new URLSearchParams({
          'ssb-http-auth': '1', cid: admin.id, cc,
        })
        const appLoginResponses = await Promise.all([0, 1].map(() => fetch(appLoginURL, { redirect: 'manual' })))
        assert.deepEqual(appLoginResponses.map((res) => res.status).sort(), [303, 403])
        const appLogin = appLoginResponses.find((res) => res.status === 303)
        assert.equal(appLogin.headers.get('location'), '/admin')

        const profile = (image) => {
          const form = new FormData()
          form.set('name', 'Test Pub <script>')
          form.set('description', 'An independently hosted pub.')
          form.set('image', image, 'profile.png')
          return form
        }
        assert.equal((await post('/admin/profile', session, profile(new Blob(['fake'])))).status, 400)
        const icon = await fetch(origin + '/assets/icon.png')
        assert.equal((await post('/admin/profile', session, profile(await icon.blob()))).status, 303)
        const landing = await (await fetch(origin)).text()
        assert.match(landing, /Test Pub &lt;script&gt;/)
        const imageURL = landing.match(/src="(\/profile-image\/[a-f0-9]{64})"/)[1]
        assert.equal((await fetch(origin + imageURL)).headers.get('content-type'), 'image/png')
        assert.match(await (await post('/admin/invite', session)).text(), /New invitation/)

        const password = 'test password with more than 12 characters'
        assert.equal(await setPassword(password), 200)
        assert.equal((await post('/admin/invite', session)).status, 403)
        const passwordPost = (secret, forwarded) => post('/login/password', null,
          new URLSearchParams({ password: secret }), origin, { 'X-Forwarded-For': forwarded })
        for (let i = 0; i < 12; i++) {
          assert.equal((await passwordPost('invalid', `198.51.100.${i + 1}, 192.0.2.1`)).status, 403)
        }
        assert.equal((await passwordPost(password, '192.0.2.1')).status, 403)
        const passwordLogin = await passwordPost(password, '192.0.2.2')
        assert.equal(passwordLogin.status, 303)
        const fallbackSession = passwordLogin.headers.get('set-cookie').split(';')[0]
        const transport = await call(admin.conn.connect, address)
        assert.equal(await call(transport.httpAuth.invalidateAllSolutions), true)
        assert.equal((await post('/admin/invite', fallbackSession)).status, 403)
      }
      const invite = await pubctl('invite')
      const badId = alice.id.slice(0, 43) + 'B' + alice.id.slice(44)
      const rejected = await fetch(origin + '/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: badId, invite: new URL(invite).searchParams.get('token') }),
      })
      assert.equal((await rejected.json()).error, 'Invalid SSB feed ID')
      const claims = await Promise.all([0, 1, 2].map(() => call(alice.httpInviteClient.claim, invite)))
      assert.deepEqual(claims, [address, address, address])
      for (const options of [{}, { stream: true }, { length: 8 * 1024 * 1024 + 1 }]) {
        await sendMalformedRpc(address, alice.config.keys, options)
        assert.equal((await fetch(origin + '/healthz')).status, 204)
      }
      const pubId = status.split('\n')[0]
      if (!tcp) alice.ebt.request(pubId, true)
      const publisher = await call(alice.connect, address)
      assert.equal(publisher.id, pubId)
      assert.match(address, tcp ? new RegExp(`^net:127.0.0.1:${tcpPort}~shs:`) : /^ws:\/\/127\.0\.0\.1:/)

      if (!tcp) {
        const profile = await until(async () => {
          const profile = await call(alice.aboutSelf.get, pubId)
          return profile.image && profile
        }, 'replicated pub profile')
        assert.equal(profile.name, 'Test Pub <script>')
        assert.equal(profile.description, 'An independently hosted pub.')
        await call(alice.blobs.want, profile.image)
        const chunks = await new Promise((resolve, reject) => {
          pull(alice.blobs.get(profile.image), pull.collect((err, chunks) => err ? reject(err) : resolve(chunks)))
        })
        assert.deepEqual(Buffer.concat(chunks).subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
        const bytes = await collect(publisher.blobs.getSlice({ key: profile.image, start: 0, end: 8 }))
        assert.deepEqual(Buffer.concat(bytes), Buffer.from('89504e470d0a1a0a', 'hex'))
        await assert.rejects(collect(publisher.blobs.getSlice({ key: profile.image, start: 8, end: 1 })),
          { message: 'Invalid blob range' })
        alice.ebt.request(pubId, false)
      }

      const post = await call(alice.db.publish, { type: 'post', text: 'Alice was here' })
      const blob = Buffer.from('Alice sent a blob')
      const blobId = await new Promise((resolve, reject) => {
        const source = (abort, cb) => {
          if (abort) return cb(abort)
          source.sent ? cb(true) : (source.sent = true, cb(null, blob))
        }
        alice.blobs.add((err, id) => err ? reject(err) : resolve(id))(source)
      })
      const blobPost = await call(alice.db.publish, {
        type: 'post',
        text: 'Alice sent an attachment',
        mentions: [{ link: blobId, name: 'example.txt' }],
      })
      const bob = await client('bob')
      await assert.rejects(call(bob.httpInviteClient.claim, invite), /already claimed/)
      assert.equal(await call(bob.httpInviteClient.claim, await pubctl('invite')), address)

      // A reader explicitly follows the author whose messages they want.
      await call(bob.db.publish, { type: 'contact', contact: alice.id, following: true })
      await call(bob.connect, address)
      const copied = await until(() => call(bob.db.get, post.key), 'replicated feed')
      assert.equal(copied.content.text, 'Alice was here')
      await until(() => call(bob.db.get, blobPost.key), 'attachment message')
      await call(bob.blobs.want, blobId)
      assert.equal(await call(bob.blobs.has, blobId), true)

      await closePeer(alice)
      await closePeer(bob)
      await stop()
      await start()
      assert.equal(await pubctl('status'), status)
      if (!tcp) {
        assert.match(await (await fetch(origin)).text(), /Test Pub &lt;script&gt;/)
        await call(admin.conn.connect, address)
        assert.equal((await fetch(appLoginURL, { redirect: 'manual' })).status, 403)
        await closePeer(admin)
      }
      const charlie = await client('charlie')
      await assert.rejects(call(charlie.httpInviteClient.claim, invite), /already claimed/)
      assert.equal(await call(charlie.httpInviteClient.claim, await pubctl('invite')), address)
      await call(charlie.db.publish, { type: 'contact', contact: alice.id, following: true })
      await call(charlie.connect, address)
      const stored = await until(() => call(charlie.db.get, post.key), 'offline author’s feed after restart')
      assert.equal(stored.content.text, 'Alice was here')
    })
}
