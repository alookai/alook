import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startProxy } from '../src/proxy.mjs'
import { api } from '../src/client.mjs'

for (const phase of ['request', 'response']) {
  test(`1000ms ${phase} calibration and unselected GET bypass`, async () => {
    let upstreamAt
    const server = http.createServer((request, response) => {
      upstreamAt = performance.now()
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ text: '你好' }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const injections = []
    const proxy = await startProxy({ upstream: `http://127.0.0.1:${server.address().port}`, delayMs: 1000, phase, emit: e => injections.push(e) })
    try {
      const start = performance.now()
      const result = await api(proxy.url, { cookie: 'test=fixture' }, '/api/community/channels/c/messages', { method: 'POST', body: { content: '你好' }, requestId: 'test' })
      assert.ok(result.wallMs >= 980)
      assert.equal(result.responseBodyBytes, Buffer.byteLength(JSON.stringify({ text: '你好' })))
      if (phase === 'request') assert.ok(upstreamAt - start >= 980)
      else assert.ok(upstreamAt - start < 800)
      assert.equal(injections.length, 1)
      assert.ok(injections[0].actualMs >= 980)
      const get = await api(proxy.url, { cookie: 'test=fixture' }, '/api/community/channels/c/messages')
      assert.ok(get.wallMs < 800)
      assert.equal(injections.length, 1)
    } finally { await proxy.close(); await new Promise(resolve => server.close(resolve)) }
  })
}
