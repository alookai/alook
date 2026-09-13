import { cpus, totalmem, release } from 'node:os'
import { chromium } from 'playwright'
import { mkdir, writeFile, appendFile, readFile, readdir } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { prepareFixture, messageEvents } from './client.mjs'
import { publicConfig } from './config.mjs'
import { installBrowserProbe, syncPageClock, metricDelta } from './browser-probe.mjs'
import { browserSummary, browserMarkdown } from './browser-report.mjs'

export const defaultScenario = {
  path: '/c/channels/{serverId}/{channelId}',
  composerSelector: '[data-testid="community-composer-input"] [contenteditable="true"]',
  submitAction: 'enter',
  scrollToPresentSelector: '[data-testid="community-scroll-to-present"]',
  submitSelector: '[data-testid="community-composer-send"]',
  messageSelector: '[data-msg-id]', idAttribute: 'data-msg-id', optimisticPrefix: 'temp_',
  sendPath: '/api/community/channels/{channelId}/messages',
}

async function metrics(session) {
  const result = await session.send('Performance.getMetrics')
  return Object.fromEntries(result.metrics.map(item => [item.name, item.value]))
}

function cookies(account, baseUrl) {
  return account.cookie.split(';').map(part => {
    const index = part.indexOf('=')
    if (index < 1) throw new Error('Invalid fixture cookie')
    return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: baseUrl }
  })
}

function fillPath(template, fixture) {
  return template.replace(/\{(serverId|channelId)\}/g, (_, key) => encodeURIComponent(fixture[key]))
}

export async function runBrowserBenchmark(config) {
  if (config.concurrency !== 1 || config.receivers !== 1) throw new Error('Browser scenario currently requires concurrency=1 and receivers=1 (two real users)')
  if (config.payloadBytes.some(size => size < 64)) throw new Error('Browser message content requires at least 64 bytes for unique sample correlation')
  const fixture = await prepareFixture(config)
  const scenario = { ...defaultScenario, ...config.scenario }
  const sendPath = fillPath(scenario.sendPath, fixture)
  const intercepted = config.observeDB || config.phases.some(phase => phase.delayMs > 0)
  const windowMs = config.observationWindowMs ?? 1500
  await mkdir(config.outDir, { recursive: true })
  if ((await readdir(config.outDir)).length) throw new Error('Output directory must be empty; preserve each run separately')
  const digest = createHash('sha256')
  for (const file of (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.mjs')).sort()) { digest.update(file); digest.update(await readFile(new URL(file, import.meta.url))) }
  digest.update(await readFile(new URL('../package-lock.json', import.meta.url)))
  const toolDigest = digest.digest('hex')
  const browser = await chromium.launch({ headless: config.headless !== false, ...(config.executablePath ? { executablePath: config.executablePath } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
  const runId = randomUUID()
  const samples = []
  const pages = []
  let active = null
  let requestSequence = 0
  const pendingCapture = new Set()
  const metadata = { kind: 'browser-user-operation', runId, startedAt: new Date().toISOString(), config: { ...publicConfig(config), observationWindowMs: windowMs, scenario, viewport: config.viewport ?? { width: 1280, height: 900 }, headless: config.headless !== false, serviceWorkers: 'block', networkMode: intercepted ? 'intercepted-cache-disabled' : 'passive-native-cache' },
    fixture, runner: { toolDigest, hardware: { cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), osRelease: release() }, node: process.version, platform: process.platform, arch: process.arch, browser: browser.version() },
    coverage: 'Two real page contexts. Browser page main-thread task CPU/JS heap (includes probe overhead); HTTP/WS application bytes; optional web env.DB. Server CPU, process RSS, physical I/O and cross-service totals not measured.' }
  await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
  await writeFile(`${config.outDir}/operations.jsonl`, '')
  try {
    for (let role = 0; role < 2; role++) {
      const context = await browser.newContext({ viewport: config.viewport ?? { width: 1280, height: 900 }, serviceWorkers: 'block' })
      await context.addCookies(cookies(config.fixture.accounts[role], config.baseUrl))
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
      let wsReady = false
      const requests = new Map()
      page.on('request', request => {
        const url = new URL(request.url())
        const operation = active
        if (!operation || !['http:', 'https:'].includes(url.protocol)) return
        const id = `${operation.id}-r${requestSequence++}`
        const record = { id, role, origin: url.origin, path: url.pathname, observedDB: config.observeDB && url.origin === config.baseUrl && url.pathname.startsWith('/api/'), method: request.method(), startMs: performance.now(),
          status: null, finishedMs: null, failure: null, requestBodyBytes: request.postDataBuffer()?.byteLength ?? 0, responseBodyBytes: null,
          isSend: url.origin === config.baseUrl && role === 0 && request.method() === 'POST' && url.pathname === sendPath }
        operation.requests.push(record)
        requests.set(request, record)
        if (record.isSend) { try { operation.clientNonce = request.postDataJSON()?.nonce ?? request.postDataJSON()?.clientNonce ?? null } catch {} }
      })
      if (intercepted) await context.route('**/api/**', async route => {
        const request = route.request()
        const record = requests.get(request)
        const operation = active
        if (!record || !operation || new URL(request.url()).origin !== config.baseUrl) return route.continue()
        const id = record.id
        const headers = { ...request.headers(), ...(config.observeDB ? { 'x-alook-benchmark-id': id } : {}) }
        if (record.isSend) {
          try { operation.clientNonce = request.postDataJSON()?.nonce ?? request.postDataJSON()?.clientNonce ?? null } catch {}
          if (operation.phaseConfig.delayMs && operation.phaseConfig.phase === 'request') {
            const at = performance.now(); await sleep(operation.phaseConfig.delayMs)
            operation.injections.push({ phase: 'request', actualMs: performance.now() - at, configuredMs: operation.phaseConfig.delayMs })
          }
          if (operation.phaseConfig.delayMs && operation.phaseConfig.phase === 'response') {
            try {
              const response = await route.fetch({ headers, timeout: config.timeoutMs, maxRetries: 0 })
              const at = performance.now(); await sleep(operation.phaseConfig.delayMs)
              operation.injections.push({ phase: 'response', actualMs: performance.now() - at, configuredMs: operation.phaseConfig.delayMs })
              await route.fulfill({ response })
            } catch { record.failure = 'interception-failed'; await route.abort().catch(() => {}) }
            return
          }
        }
        await route.continue({ headers }).catch(() => { record.failure = 'interception-failed' })
      })
      page.on('requestfailed', request => {
        const record = requests.get(request)
        if (record) { record.failure = 'request-failed'; record.finishedMs = performance.now() }
      })
      page.on('response', response => {
        const record = requests.get(response.request())
        if (!record) return
        record.status = response.status()
        const capture = (async () => {
          try {
            const body = await response.body()
            record.finishedMs = performance.now(); record.responseBodyBytes = body.length
            if (record.isSend) {
              try { record.messageId = JSON.parse(body.toString('utf8'))?.message?.id ?? null } catch { record.failure = 'invalid-json' }
            }
          } catch { record.failure = 'body-unavailable'; record.finishedMs = performance.now() }
        })()
        pendingCapture.add(capture); capture.finally(() => pendingCapture.delete(capture))
      })
      page.on('websocket', socket => {
        socket.on('framereceived', ({ payload }) => {
          let parsed
          try { parsed = JSON.parse(payload.toString()) } catch {}
          if (parsed?.type === 'auth.ok') wsReady = true
          if (!active) return
          active.frames.push({ role, direction: 'receive', atMs: performance.now(), bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength, type: parsed?.type ?? 'unparsed', messages: parsed ? messageEvents(parsed).map(event => ({ id: event.message.id, clientNonce: event.message.clientNonce ?? null })) : [] })
        })
        socket.on('framesent', ({ payload }) => {
          if (active) active.frames.push({ role, direction: 'send', atMs: performance.now(), bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength })
        })
        socket.on('close', () => { wsReady = false })
      })
      await page.goto(new URL(fillPath(scenario.path, fixture), config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.locator(scenario.composerSelector).waitFor({ state: 'visible', timeout: 30000 })
      const deadline = performance.now() + config.timeoutMs
      while (!wsReady && performance.now() < deadline) await sleep(25)
      if (!wsReady) throw new Error('Real page WS did not authenticate')
      const scroll = page.locator(scenario.scrollToPresentSelector)
      await sleep(500)
      const scrollDeadline = performance.now() + config.timeoutMs
      while (await scroll.isVisible()) {
        if (performance.now() >= scrollDeadline) throw new Error('Could not prepare page at latest messages')
        await scroll.click()
        await sleep(350)
      }
      await page.evaluate(installBrowserProbe, scenario)
      pages.push({ page, context, cdp, clock: await syncPageClock(page), wsReady: () => wsReady })
    }
    metadata.clocks = pages.map(item => item.clock)
    for (let role = 0; role < pages.length; role++) {
      await pages[role].page.screenshot({ path: `${config.outDir}/ready-${role}.png` })
      if (await pages[role].page.locator(scenario.composerSelector).count() !== 1) throw new Error('Expected exactly one prepared composer')
    }
    for (const phase of config.phases) {
      for (const payloadBytes of config.payloadBytes) {
        for (let index = 0; index < config.warmup + config.samples; index++) {
          const id = `${runId}-${samples.length}`
          const marker = `benchmark-${id.slice(0, 8)}-${samples.length}-`
          const content = marker + 'x'.repeat(payloadBytes - marker.length)
          await pages[0].page.locator(scenario.composerSelector).fill(content)
          const before = await Promise.all(pages.map(item => metrics(item.cdp)))
          await Promise.all(pages.map(item => item.page.evaluate(text => window.__BENCHMARK_PROBE__.arm(text), content)))
          const operation = { id, phase: phase.name, phaseConfig: phase, payloadBytes, warmup: index < config.warmup, startedMs: performance.now(), requests: [], frames: [], injections: [], clientNonce: null, error: null }
          active = operation
          try {
            if (pages.some(item => !item.wsReady())) throw new Error('Page WS disconnected')
            if (scenario.submitAction === 'enter') await pages[0].page.locator(scenario.composerSelector).press('Enter', { timeout: config.timeoutMs })
            else await pages[0].page.locator(scenario.submitSelector).click({ timeout: config.timeoutMs })
            await Promise.all(pages.map(item => item.page.waitForFunction(() => {
              const sample = window.__BENCHMARK_PROBE__.snapshot()
              return sample?.visibleMs !== null && sample?.nextFrameMs !== null && sample?.messageId !== null
            }, undefined, { timeout: config.timeoutMs })))
          } catch { operation.error = 'action-or-visibility-timeout' }
          const left = operation.startedMs + windowMs - performance.now()
          if (left > 0) await sleep(left)
          const snapshots = await Promise.all(pages.map(item => item.page.evaluate(() => window.__BENCHMARK_PROBE__.freeze())))
          operation.cutoffMs = performance.now()
          active = null
          operation.requestsAtCutoff = structuredClone(operation.requests)
          operation.framesAtCutoff = structuredClone(operation.frames)
          operation.clickMs = snapshots[0]?.clickMs === null ? null : snapshots[0].clickMs + pages[0].clock.offsetMs
          operation.submit = { atMs: snapshots[0]?.clickMs, eventType: snapshots[0]?.eventType, isTrusted: snapshots[0]?.isTrusted }
          operation.dom = snapshots.map((snapshot, role) => ({ role, visibilityState: snapshot.visibilityState, timeOrigin: snapshot.timeOrigin, firstId: snapshot.firstId, messageId: snapshot.messageId,
            visibleMs: snapshot.visibleMs === null || operation.clickMs === null ? null : snapshot.visibleMs - snapshots[0].clickMs,
            nextFrameMs: snapshot.nextFrameMs === null || operation.clickMs === null ? null : snapshot.nextFrameMs - snapshots[0].clickMs,
            canonicalMs: snapshot.canonicalMs === null || operation.clickMs === null ? null : snapshot.canonicalMs - snapshots[0].clickMs }))
          const after = await Promise.all(pages.map(item => metrics(item.cdp)))
          operation.resources = after.map((values, role) => ({ role,
            observedWindow: 'before probe arm through after DOM freeze; includes driver/probe overhead',
            taskCpuMs: metricDelta(before[role], values, 'TaskDuration', 1000),
            scriptCpuMs: metricDelta(before[role], values, 'ScriptDuration', 1000),
            layoutCpuMs: metricDelta(before[role], values, 'LayoutDuration', 1000),
            jsHeapBeforeBytes: before[role].JSHeapUsedSize ?? null, jsHeapAfterBytes: values.JSHeapUsedSize ?? null }))
          operation.unfinishedRequestsAtCutoff = operation.requests.filter(r => r.finishedMs === null).length
          operation.wsDisconnected = pages.map(item => !item.wsReady())
          operation.sameCanonicalMessage = !!operation.dom[0].messageId && operation.dom[0].messageId === operation.dom[1].messageId
          const sendIds = operation.requests.filter(r => r.isSend && r.messageId).map(r => r.messageId)
          operation.httpCanonicalMatch = sendIds.length > 0 ? sendIds.every(id => id === operation.dom[0].messageId) : null
          operation.receivedMessageFrames = operation.frames.filter(frame => frame.role === 1 && frame.messages?.some(message => message.id === operation.dom[1].messageId)).length
          operation.duplicateMessageFrames = Math.max(0, operation.receivedMessageFrames - 1)
          if (operation.httpCanonicalMatch === false) operation.error ??= 'http-message-mismatch'
          if (!operation.sameCanonicalMessage) operation.error ??= 'canonical-message-mismatch'
          if (samples.length === 0 || (phase === config.phases.at(-1) && payloadBytes === config.payloadBytes.at(-1) && index === config.warmup + config.samples - 1)) {
            for (let role = 0; role < 2; role++) await pages[role].page.screenshot({ path: `${config.outDir}/sample-${samples.length}-page-${role}.png` })
          }
          samples.push(operation)
          await appendFile(`${config.outDir}/operations.jsonl`, JSON.stringify(operation) + '\n')
          await Promise.all(pages.map(item => item.page.evaluate(() => window.__BENCHMARK_PROBE__.stop())))
          if (config.intervalMs) await sleep(config.intervalMs)
        }
      }
    }
    metadata.resourceCoverage = { webDB: config.observeDB ? 'request-header-correlated adapter; verify log completion coverage' : 'not instrumented', wsDo: 'browser-observed WS application frames only; server resources unknown', queue: 'not instrumented', browserCPU: 'page main-thread threadTicks only', browserHeap: 'JS heap snapshots only' }
    metadata.finalClocks = await Promise.all(pages.map(item => syncPageClock(item.page)))
    metadata.finishedAt = new Date().toISOString()
    await Promise.race([Promise.allSettled([...pendingCapture]), sleep(config.timeoutMs)])
    await writeFile(`${config.outDir}/operations.jsonl`, samples.map(sample => JSON.stringify(sample)).join('\n') + '\n')
    await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
    const report = browserSummary(samples, metadata)
    await writeFile(`${config.outDir}/summary.json`, JSON.stringify(report, null, 2))
    await writeFile(`${config.outDir}/summary.md`, browserMarkdown(report))
    return report
  } finally { active = null; await browser.close() }
}
