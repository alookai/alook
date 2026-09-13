import http from 'node:http'
import https from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'

export async function startProxy({ upstream, delayMs = 0, port = 0, emit = () => {} }) {
  const target = new URL(upstream)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Proxy requires an HTTP(S) upstream')
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('Invalid delay configuration')
  const server = http.createServer(async (request, response) => {
    const selected = request.method === 'POST' && /^\/api\/community\/channels\/[^/]+\/messages(?:\?|$)/.test(request.url)
    const requestId = request.headers['x-alook-benchmark-id']
    const inject = async () => {
      const started = performance.now()
      await sleep(delayMs)
      emit({ kind: 'injection', requestId, configuredMs: delayMs, actualMs: performance.now() - started })
    }
    if (selected) await inject()
    if (response.destroyed) return
    const transport = target.protocol === 'https:' ? https : http
    const forwarded = transport.request(new URL(request.url, target), {
      method: request.method, headers: { ...request.headers, host: target.host, origin: target.origin },
    }, incoming => {
      if (response.destroyed) { incoming.destroy(); return }
      response.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(response)
      incoming.on('error', () => response.destroy())
    })
    forwarded.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    response.on('close', () => forwarded.destroy())
    request.pipe(forwarded)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
