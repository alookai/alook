import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { runBenchmark } from '../src/runner.mjs'

function frame(socket, object) {
  const data = Buffer.from(JSON.stringify(object))
  const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
  socket.write(Buffer.concat([header, data]))
}

test('real HTTP/WS control keeps pre-ACK delivery, nonce correlation, late duplicates and private data out of artifacts', async () => {
  const sockets = []
  const messages = []
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    const url = new URL(request.url, 'http://local')
    let result
    if (url.pathname === '/api/ws/token') result = { userId: 'receiver', token: 'secret-token' }
    else if (url.pathname.endsWith('/servers/s/members')) result = { members: [{ userId: 'sender' }, { userId: 'receiver' }], hasMore: false }
    else if (url.pathname.endsWith('/channels/c/members')) result = { members: [{ userId: 'sender' }, { userId: 'receiver' }] }
    else if (url.pathname.endsWith('/channels/c')) result = { id: 'c', serverId: 's', type: 'text', parentChannelId: null, categoryId: null }
    else if (request.method === 'POST') {
      let body = ''
      for await (const part of request) body += part
      const sent = JSON.parse(body)
      const message = { id: `m${messages.length}`, clientNonce: sent.nonce, content: sent.content }
      messages.unshift(message)
      const batch = { type: 'community:events.batch', events: [{ type: 'community:message.create', channelId: 'c', message }] }
      for (const socket of sockets) frame(socket, batch)
      setTimeout(() => { for (const socket of sockets) if (!socket.destroyed) frame(socket, batch) }, 40)
      result = { message }
    } else result = { messages }
    response.end(JSON.stringify(result))
  })
  server.on('upgrade', (request, socket) => {
    assert.equal(new URL(request.url, 'http://local').searchParams.get('userId'), 'receiver')
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.once('data', () => frame(socket, { type: 'auth.ok' }))
    sockets.push(socket)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const outDir = await mkdtemp(join(os.tmpdir(), 'benchmark-control-'))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const report = await runBenchmark({ baseUrl, wsUrl: baseUrl.replace('http', 'ws') + '/api/ws/user', targetKind: 'local', targetVersion: 'control', environment: 'controlled HTTP/WS', outDir,
      samples: 2, warmup: 0, concurrency: 1, timeoutMs: 2000, intervalMs: 60, receivers: 1, expectedMembers: 2, historyLimit: 20, observeDB: false,
      payloadBytes: [64], phases: [{ name: 'response', phase: 'response', delayMs: 100 }],
      fixture: { serverId: 's', channelId: 'c', accounts: [{ userId: 'sender', cookie: 'session=secret-cookie' }, { userId: 'receiver', cookie: 'session=secret-cookie' }] } })
    const samples = (await readFile(`${outDir}/samples.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(samples.length, 2)
    assert.ok(samples.every(s => s.receivers[0].receiveMs < s.ackMs))
    assert.ok(samples.every(s => s.receivers[0].duplicates === 1))
    assert.ok(samples.every(s => s.history.containsSentMessage))
    assert.equal(report.groups[0].delivered, 2)
    assert.equal(report.groups[0].duplicates, 2)
    for (const file of ['samples.jsonl', 'summary.json', 'metadata.json', 'injections.jsonl']) {
      const text = await readFile(`${outDir}/${file}`, 'utf8')
      assert.ok(!text.includes('secret-cookie') && !text.includes('secret-token'))
    }
  } finally {
    sockets.forEach(socket => socket.destroy())
    await new Promise(resolve => server.close(resolve))
    await rm(outDir, { recursive: true, force: true })
  }
})
