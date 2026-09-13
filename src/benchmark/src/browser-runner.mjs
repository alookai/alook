import { cpus, totalmem, release } from 'node:os'
import { chromium } from 'playwright'
import { mkdir, writeFile, appendFile, readFile, readdir } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { publicConfig } from './config.mjs'
import { syncPageClock, metricDelta } from './browser-probe.mjs'
import { browserSummary, browserMarkdown } from './browser-report.mjs'
import { resolveCase } from './cases/index.mjs'

async function metrics(session) {
  return Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]))
}
function cookies(cookie, baseUrl) {
  if (!cookie) return []
  return cookie.split(';').map(part => {
    const index = part.indexOf('=')
    if (index < 1) throw new Error('Invalid participant cookie')
    return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: baseUrl }
  })
}
async function sourceDigest() {
  const digest = createHash('sha256')
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(new URL(entry.name + '/', directory), name + '/')
      else if (entry.name.endsWith('.mjs')) { digest.update(name); digest.update(await readFile(new URL(entry.name, directory))) }
    }
  }
  await walk(new URL('.', import.meta.url))
  digest.update(await readFile(new URL('../package-lock.json', import.meta.url)))
  return digest.digest('hex')
}

export async function runBrowserBenchmark(config, suppliedCase) {
  if (config.concurrency !== 1) throw new Error('Browser runner currently requires serial concurrency=1')
  const benchmarkCase = suppliedCase ?? resolveCase(config)
  for (const key of ['prepare', 'setupPage', 'prepareSample', 'arm', 'perform', 'freeze', 'finish']) if (typeof benchmarkCase[key] !== 'function') throw new Error(`Case requires ${key}`)
  if (!benchmarkCase.id || !Number.isInteger(benchmarkCase.version) || !benchmarkCase.metrics || !Object.keys(benchmarkCase.metrics).length) throw new Error('Case requires identity, version and metric definitions')
  for (const definition of Object.values(benchmarkCase.metrics)) if (!definition.label || !definition.unit || typeof definition.successOnly !== 'boolean') throw new Error('Metrics require label, unit and successOnly')
  const prepared = await benchmarkCase.prepare({ config })
  const { fixture, participants, workloads } = prepared
  if (!participants?.length || !workloads?.length || new Set(workloads.map(item => item.id)).size !== workloads.length) throw new Error('Case requires participants and distinct workloads')
  const intercepted = config.observeDB || config.phases.some(phase => phase.delayMs > 0)
  const windowMs = config.observationWindowMs ?? 1800
  await mkdir(config.outDir, { recursive: true })
  if ((await readdir(config.outDir)).length) throw new Error('Output directory must be empty; preserve each run separately')
  const browser = await chromium.launch({ headless: config.headless !== false, ...(config.executablePath ? { executablePath: config.executablePath } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
  const runId = randomUUID(), samples = [], pages = [], pendingCapture = new Set()
  let active = null, requestSequence = 0
  const metadata = { kind: 'browser-user-operation', schemaVersion: 2, runId, startedAt: new Date().toISOString(),
    case: { id: benchmarkCase.id, version: benchmarkCase.version, metrics: benchmarkCase.metrics, options: benchmarkCase.options ?? {} }, workloads,
    participants: participants.map((item, role) => ({ role, name: item.name })), fixture,
    config: { ...publicConfig(config), observationWindowMs: windowMs, viewport: config.viewport ?? { width: 1280, height: 900 }, headless: config.headless !== false, serviceWorkers: 'block', networkMode: intercepted ? 'intercepted-cache-disabled' : 'passive-native-cache' },
    runner: { toolDigest: await sourceDigest(), hardware: { cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), osRelease: release() }, node: process.version, platform: process.platform, arch: process.arch, browser: browser.version() },
    coverage: 'Real browser pages; page main-thread CPU/JS heap including observer overhead; HTTP/WS application bytes; optional web env.DB only. Unobserved services, server CPU/RSS and physical I/O unknown.' }
  await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
  await writeFile(`${config.outDir}/operations.jsonl`, '')
  try {
    for (let role = 0; role < participants.length; role++) {
      const participant = participants[role]
      const context = await browser.newContext({ viewport: metadata.config.viewport, serviceWorkers: 'block' })
      await context.addCookies(cookies(participant.cookie, config.baseUrl))
      const page = await context.newPage(), cdp = await context.newCDPSession(page)
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
      const connection = { ready: false, closes: 0 }, requests = new Map()
      page.on('request', request => {
        const operation = active, url = new URL(request.url())
        if (!operation || !['http:', 'https:'].includes(url.protocol)) return
        let classification = {}
        try { classification = benchmarkCase.classifyRequest?.({ request, role, fixture, operation, config }) ?? {} }
        catch { operation.collectorErrors.push('case-request-classification-failed') }
        const record = { id: `${operation.id}-r${requestSequence++}`, role, origin: url.origin, path: url.pathname, method: request.method(),
          observedDB: config.observeDB && url.origin === config.baseUrl && classification.observeDB !== false,
          direct: classification.direct === true, inject: classification.inject === true, details: classification.details ?? null,
          startMs: performance.now(), status: null, finishedMs: null, failure: null, requestBodyBytes: request.postDataBuffer()?.byteLength ?? 0, responseBodyBytes: null }
        operation.requests.push(record); requests.set(request, record)
      })
      if (intercepted) await context.route('**/*', async route => {
        const request = route.request(), record = requests.get(request), operation = active
        if (!record || !operation || (!record.observedDB && !record.inject)) return route.continue()
        const headers = { ...request.headers(), ...(record.observedDB ? { 'x-alook-benchmark-id': record.id } : {}) }
        if (record.inject && operation.phaseConfig.delayMs) {
          const at = performance.now(); await sleep(operation.phaseConfig.delayMs)
          operation.injections.push({ requestId: record.id, actualMs: performance.now() - at, configuredMs: operation.phaseConfig.delayMs })
        }
        await route.continue({ headers }).catch(() => { record.failure = 'interception-failed' })
      })
      page.on('requestfailed', request => { const record = requests.get(request); if (record) { record.failure = 'request-failed'; record.finishedMs = performance.now() } })
      page.on('response', response => {
        const record = requests.get(response.request())
        if (!record) return
        record.status = response.status()
        const capture = (async () => {
          try {
            const body = await response.body()
            record.finishedMs = performance.now(); record.responseBodyBytes = body.length
            try { record.responseDetails = benchmarkCase.responseDetails?.({ record, body, fixture, config }) ?? null }
            catch { record.failure = 'case-response-decode-failed' }
          } catch { record.failure = 'body-unavailable'; record.finishedMs = performance.now() }
        })()
        pendingCapture.add(capture); capture.finally(() => pendingCapture.delete(capture))
      })
      page.on('websocket', socket => {
        const receive = direction => ({ payload }) => {
          let decoded = {}
          try { decoded = benchmarkCase.frameDetails?.({ payload, direction, role, fixture, config }) ?? {} }
          catch { active?.collectorErrors.push('case-frame-decode-failed') }
          if (typeof decoded.ready === 'boolean') connection.ready = decoded.ready
          if (active) active.frames.push({ role, direction, atMs: performance.now(), bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength, details: decoded.details ?? null })
        }
        socket.on('framereceived', receive('receive')); socket.on('framesent', receive('send'))
        socket.on('close', () => { connection.ready = false; connection.closes++ })
      })
      await page.goto(new URL(participant.path, config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await benchmarkCase.setupPage({ page, context, connection, participant, role, fixture, config })
      pages.push({ page, context, cdp, connection, clock: await syncPageClock(page) })
      await page.screenshot({ path: `${config.outDir}/ready-${role}.png` })
    }
    metadata.clocks = pages.map(item => item.clock)
    for (const phase of config.phases) for (const workload of workloads) for (let index = 0; index < config.warmup + config.samples; index++) {
      const id = `${runId}-${samples.length}`, hook = { config, fixture, pages, workload, id }
      const input = await benchmarkCase.prepareSample(hook)
      const before = await Promise.all(pages.map(item => metrics(item.cdp))), closes = pages.map(item => item.connection.closes)
      await benchmarkCase.arm({ ...hook, input })
      const operation = { id, phase: phase.name, phaseConfig: phase, workloadId: workload.id, warmup: index < config.warmup, startedMs: performance.now(), requests: [], frames: [], injections: [], collectorErrors: [], error: null }
      active = operation
      try { await benchmarkCase.perform({ ...hook, input, operation }) } catch { operation.error = 'action-or-completion-timeout' }
      const left = operation.startedMs + windowMs - performance.now()
      if (left > 0) await sleep(left)
      let snapshot
      try { snapshot = await benchmarkCase.freeze({ ...hook, input, operation }) } catch { operation.error ??= 'case-freeze-failed' }
      operation.cutoffMs = performance.now(); active = null
      operation.requestsAtCutoff = structuredClone(operation.requests); operation.framesAtCutoff = structuredClone(operation.frames)
      try { operation.result = await benchmarkCase.finish({ ...hook, input, snapshot, operation }) } catch { operation.error ??= 'case-result-failed'; operation.result = { metrics: {} } }
      operation.error ??= operation.result.error ?? (operation.collectorErrors.length ? 'collector-error' : null)
      const submit = operation.result.submit
      const validSubmit = Number.isInteger(submit?.role) && !!pages[submit.role] && Number.isFinite(submit?.atMs) && submit.isTrusted === true
      operation.submitNodeMs = validSubmit ? submit.atMs + pages[submit.role].clock.offsetMs : null
      if (!validSubmit || operation.submitNodeMs < operation.startedMs - pages[submit.role].clock.roundTripMs || operation.submitNodeMs > operation.cutoffMs) operation.error ??= 'invalid-trusted-submit'
      for (const name of Object.keys(benchmarkCase.metrics)) if (!Number.isFinite(operation.result.metrics?.[name])) operation.error ??= 'missing-or-invalid-case-metric'
      const after = await Promise.all(pages.map(item => metrics(item.cdp)))
      operation.resources = after.map((values, role) => ({ role, observedWindow: 'before case arm through after freeze; includes driver/probe overhead',
        taskCpuMs: metricDelta(before[role], values, 'TaskDuration', 1000), scriptCpuMs: metricDelta(before[role], values, 'ScriptDuration', 1000), layoutCpuMs: metricDelta(before[role], values, 'LayoutDuration', 1000),
        jsHeapBeforeBytes: before[role].JSHeapUsedSize ?? null, jsHeapAfterBytes: values.JSHeapUsedSize ?? null }))
      operation.unfinishedRequestsAtCutoff = operation.requestsAtCutoff.filter(record => record.finishedMs === null).length
      operation.socketCloses = pages.map((item, role) => item.connection.closes - closes[role])
      if (samples.length === 0 || (phase === config.phases.at(-1) && workload === workloads.at(-1) && index === config.warmup + config.samples - 1)) {
        for (let role = 0; role < pages.length; role++) await pages[role].page.screenshot({ path: `${config.outDir}/sample-${samples.length}-page-${role}.png` })
      }
      samples.push(operation); await appendFile(`${config.outDir}/operations.jsonl`, JSON.stringify(operation) + '\n')
      if (config.intervalMs) await sleep(config.intervalMs)
    }
    metadata.finalClocks = await Promise.all(pages.map(item => syncPageClock(item.page)))
    await Promise.race([Promise.allSettled([...pendingCapture]), sleep(config.timeoutMs)])
    metadata.finishedAt = new Date().toISOString()
    await writeFile(`${config.outDir}/operations.jsonl`, samples.map(sample => JSON.stringify(sample)).join('\n') + '\n')
    await writeFile(`${config.outDir}/metadata.json`, JSON.stringify(metadata, null, 2))
    const report = browserSummary(samples, metadata)
    await writeFile(`${config.outDir}/summary.json`, JSON.stringify(report, null, 2)); await writeFile(`${config.outDir}/summary.md`, browserMarkdown(report))
    return report
  } finally { active = null; await browser.close() }
}
