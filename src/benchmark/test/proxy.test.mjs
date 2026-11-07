import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startProxy } from '../src/proxy.mjs'
import { api } from '../src/client.mjs'

test('1000ms request calibration and unselected GET bypass', async () => {
  let upstreamAt
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-alook-community-contract'], '10')
    response.setHeader('X-Alook-Community-Contract', '10')
    upstreamAt = performance.now()
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ text: '你好' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const injections = []
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${server.address().port}`, delayMs: 1000, emit: e => injections.push(e) })
  try {
    const start = performance.now()
    const result = await api(proxy.url, { cookie: 'test=fixture' }, '/api/community/channels/c/messages', { communityContractVersion: 10, method: 'POST', body: { content: '你好' }, requestId: 'test' })
    assert.equal(result.protocolError, false)
    assert.ok(result.wallMs >= 980)
    assert.equal(result.responseBodyBytes, Buffer.byteLength(JSON.stringify({ text: '你好' })))
    assert.ok(upstreamAt - start >= 980)
    assert.equal(injections.length, 1)
    assert.ok(injections[0].actualMs >= 980)
    const get = await api(proxy.url, { cookie: 'test=fixture' }, '/api/community/channels/c/messages', { communityContractVersion: 10 })
    assert.ok(get.wallMs < 800)
    assert.equal(injections.length, 1)
  } finally { await proxy.close(); await new Promise(resolve => server.close(resolve)) }
})
