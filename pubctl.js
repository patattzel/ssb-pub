'use strict'

const http = require('node:http')
const loadConfig = require('./config')

const command = process.argv[2]
if (process.argv.length !== 3 || !['invite', 'status'].includes(command)) {
  console.error('Usage: pubctl invite | status')
  process.exit(2)
}

const req = http.request({
  socketPath: loadConfig().socket,
  path: '/' + command,
  method: command === 'invite' ? 'POST' : 'GET',
  timeout: 5000,
}, (res) => {
  res.setEncoding('utf8')
  let body = ''
  res.on('data', (chunk) => { body += chunk })
  res.on('end', () => {
    if (res.statusCode !== (command === 'invite' ? 201 : 200)) {
      console.error(`Pub request failed (HTTP ${res.statusCode}). Check the app logs.`)
      process.exitCode = 1
      return
    }
    const result = JSON.parse(body)
    console.log(command === 'invite' ? result.url : `${result.id}\n${result.address}`)
  })
})
req.on('timeout', () => req.destroy(new Error('request timed out')))
req.on('error', (err) => {
  console.error(`Cannot contact the Pub (${err.code || err.message}). Is it running?`)
  process.exitCode = 1
})
req.end()
