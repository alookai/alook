import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import os from 'node:os'
import { api, prepareFixture, connectReceiver } from './client.mjs'
import { startProxy } from './proxy.mjs'
import { publicConfig } from './config.mjs'
import { summarize, markdown } from './report.mjs'

export async function runBenchmark(config) {
  const fixture = await prepareFixture(config)
  await mkdir(config.outDir, { recursive: true })
  const runId = randomUUID()
  const metadata = { runId, startedAt: new Date().toISOString(), config: publicConfig(config), fixture,
    runner: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    adapterVersion: '1', workload: 'public-text send + authenticated WS receive + first-page history GET' }
  await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
  await writeFile(`${config.outDir}/samples.jsonl`, '')
  await writeFile(`${config.outDir}/injections.jsonl`, '')
  const arrivals = new Map()
  const nonceIds = new Map()
  const sockets = []
  const samples = []
  const injections = []
  let proxy
  let index = 0
  try {
    for (let receiver = 0; receiver < config.receivers; receiver++) {
      sockets.push(await connectReceiver(config, config.fixture.accounts[receiver + 1], receiver, event => {
        if (event.channelId !== fixture.channelId) return
        if (event.clientNonce) nonceIds.set(event.clientNonce, event.messageId)
        const key = `${event.messageId}:${event.receiver}`
        const events = arrivals.get(key) ?? []
        events.push(event)
        arrivals.set(key, events)
      }))
    }
    for (const phase of config.phases) {
      proxy = await startProxy({ upstream: config.baseUrl, ...phase, emit: event => injections.push(event) })
      for (const payloadBytes of config.payloadBytes) {
        for (const warmup of [true, false]) {
          let remaining = warmup ? config.warmup : config.samples
          await Promise.all(Array.from({ length: config.concurrency }, async () => {
            while (remaining-- > 0) {
              const requestId = `${runId}-${index++}`
              const startedMs = performance.now()
              const sample = { requestId, phase: phase.name, payloadBytes, warmup, startedMs,
                status: null, ackMs: null, messageId: null, error: null, parseError: false,
                requestBodyBytes: Buffer.byteLength(JSON.stringify({ content: 'x'.repeat(payloadBytes), nonce: requestId })), responseBodyBytes: null }
              try {
                if (sockets.some(s => s.state().closed)) throw new Error('receiver-disconnected')
                const sent = await api(proxy.url, config.fixture.accounts[0], `/api/community/channels/${fixture.channelId}/messages`, {
                  method: 'POST', body: { content: 'x'.repeat(payloadBytes), nonce: requestId }, timeoutMs: config.timeoutMs, requestId: config.observeDB ? requestId : undefined,
                })
                Object.assign(sample, { status: sent.status, ackMs: sent.wallMs, parseError: sent.parseError,
                  requestBodyBytes: sent.requestBodyBytes, responseBodyBytes: sent.responseBodyBytes,
                  messageId: typeof sent.data?.message?.id === 'string' ? sent.data.message.id : null })
                if (!sent.ok || !sample.messageId) sample.error = sent.parseError ? 'invalid-json' : 'send-failed'
              } catch (error) { sample.error = error.name === 'TimeoutError' ? 'send-timeout' : 'send-transport-or-receiver-error' }
              sample.correlation = sample.messageId ? 'http-message-id' : nonceIds.has(requestId) ? 'ws-client-nonce' : 'unresolved'
              sample.messageId ??= nonceIds.get(requestId) ?? null
              if (sample.messageId) {
                while (performance.now() - startedMs < config.timeoutMs) {
                  if (sockets.every((_, receiver) => arrivals.has(`${sample.messageId}:${receiver}`))) break
                  await sleep(10)
                }
              }
              const deadline = startedMs + config.timeoutMs
              sample.receivers = sockets.map((_, receiver) => {
                const events = arrivals.get(`${sample.messageId}:${receiver}`) ?? []
                const accepted = events.filter(e => e.at >= startedMs && e.at <= deadline)
                return { receiver, receiveMs: accepted.length ? accepted[0].at - startedMs : null,
                  frameBytes: accepted[0]?.frameBytes ?? null, duplicates: Math.max(0, accepted.length - 1), late: events.filter(e => e.at > deadline).length }
              })
              if (sample.messageId) {
                const historyId = `${requestId}-h`
                try {
                  const history = await api(proxy.url, config.fixture.accounts[1], `/api/community/channels/${fixture.channelId}/messages?limit=${config.historyLimit}`, { requestId: config.observeDB ? historyId : undefined, timeoutMs: config.timeoutMs })
                  sample.history = { requestId: historyId, ok: history.ok && !history.parseError && Array.isArray(history.data?.messages),
                    status: history.status, wallMs: history.wallMs, responseBodyBytes: history.responseBodyBytes,
                    returnedMessages: Array.isArray(history.data?.messages) ? history.data.messages.length : null,
                    containsSentMessage: history.data?.messages?.some(m => m.id === sample.messageId) ?? false, limit: config.historyLimit }
                } catch { sample.history = { requestId: historyId, ok: false, status: null, wallMs: null } }
              }
              sample.finishedMs = performance.now()
              sample.observationDeadlineMs = deadline
              samples.push(sample)
              await appendFile(`${config.outDir}/samples.jsonl`, `${JSON.stringify(sample)}\n`)
              if (config.intervalMs) await sleep(config.intervalMs)
            }
          }))
        }
      }
      await proxy.close()
      proxy = undefined
    }
  } finally {
    sockets.forEach(socket => socket.close())
    await proxy?.close()
    await writeFile(`${config.outDir}/injections.jsonl`, injections.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
  const observationClosedMs = performance.now()
  for (const sample of samples) {
    sample.messageId ??= nonceIds.get(sample.requestId) ?? null
    if (sample.correlation === 'unresolved' && sample.messageId) sample.correlation = 'ws-client-nonce'
    sample.observationClosedMs = observationClosedMs
    sample.receivers = sockets.map((_, receiver) => {
      const events = arrivals.get(`${sample.messageId}:${receiver}`) ?? []
      const accepted = events.filter(e => e.at >= sample.startedMs && e.at <= sample.observationDeadlineMs)
      return { receiver, receiveMs: accepted.length ? accepted[0].at - sample.startedMs : null,
        frameBytes: accepted[0]?.frameBytes ?? null, duplicates: Math.max(0, accepted.length - 1),
        late: events.filter(e => e.at > sample.observationDeadlineMs).length,
        outcome: accepted.length ? 'delivered' : sample.messageId ? 'not-observed' : 'unresolved' }
    })
  }
  await writeFile(`${config.outDir}/samples.jsonl`, samples.map(s => JSON.stringify(s)).join('\n') + '\n')
  metadata.receiverStates = sockets.map(socket => socket.state())
  metadata.finishedAt = new Date().toISOString()
  metadata.observationClosedMs = observationClosedMs
  await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
  const report = summarize(samples, metadata)
  await writeFile(`${config.outDir}/summary.json`, JSON.stringify(report, null, 2))
  await writeFile(`${config.outDir}/summary.md`, markdown(report))
  return report
}
