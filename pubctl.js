'use strict'

const http = require('node:http')
const readline = require('node:readline/promises')
const { Writable } = require('node:stream')
const loadConfig = require('./config')

function request(command, values) {
  return new Promise((resolve, reject) => {
    const body = values && JSON.stringify(values)
    const req = http.request({
      socketPath: loadConfig().socket,
      path: '/' + command,
      method: command === 'status' ? 'GET' : 'POST',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: 5000,
    }, (res) => {
      res.setEncoding('utf8')
      let data = ''
      res.on('error', reject)
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        const result = data && JSON.parse(data)
        if (res.statusCode !== (command === 'invite' ? 201 : 200)) {
          reject(new Error(result?.error || `Pub request failed (HTTP ${res.statusCode}). Check the app logs.`))
        } else {
          resolve(result)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', (err) => reject(new Error(`Cannot contact the Pub (${err.code || err.message}). Is it running?`)))
    req.end(body)
  })
}

async function prompt(question, secret = false) {
  if (!process.stdin.isTTY) throw new Error('An interactive terminal is required for this prompt.')
  const quiet = new Writable({ write(_chunk, _encoding, cb) { cb() } })
  const input = readline.createInterface({
    input: process.stdin, output: secret ? quiet : process.stderr, terminal: true,
  })
  if (secret) process.stderr.write(question)
  try {
    return await input.question(secret ? '' : question)
  } finally {
    input.close()
    if (secret) process.stderr.write('\n')
  }
}

async function run() {
  const [command, feed, ...extra] = process.argv.slice(2)
  if (extra.length || (feed && command !== 'admin') || !['invite', 'status', 'admin', 'password'].includes(command)) {
    console.error('Usage: pubctl invite | status | admin [SSB-ID] | password')
    process.exitCode = 2
    return
  }
  let values
  if (command === 'admin') values = { id: (feed || await prompt('Public Manyverse SSB ID: ')).trim() }
  if (command === 'password') {
    const password = await prompt('New admin password: ', true)
    if (password !== await prompt('Repeat password: ', true)) throw new Error('The passwords do not match.')
    values = { password }
  }
  const result = await request(command, values)
  console.log(result.message || result.url || `${result.id}\n${result.address}`)
}

run().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
