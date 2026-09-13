import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig } from '../src/config.mjs'
import { resolveCase } from '../src/cases/index.mjs'
import { runBrowserBenchmark } from '../src/browser-runner.mjs'
const exec = promisify(execFile)
const root = resolve(process.argv[2] ?? 'artifacts')
await mkdir(root, { recursive: true })
const out = await mkdtemp(`${root}/extension-control-`)
let count = 0
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/increment') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ count: ++count })); return }
  res.setHeader('Content-Type', 'text/html')
  res.end('<button id="increment">Increment</button><output id="count">0</output><script>document.querySelector("#increment").onclick=async()=>{const r=await fetch("/increment",{method:"POST"});document.querySelector("#count").textContent=(await r.json()).count}</script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = { case: 'http-counter-control', baseUrl: `http://127.0.0.1:${server.address().port}`, targetKind: 'local', targetVersion: 'counter-control-v1', environment: 'single-page extension control', samples: 2, warmup: 0, intervalMs: 0, observationWindowMs: 300, phases: [{ name: 'baseline', delayMs: 0 }], timeoutMs: 3000 }
try {
  for (const name of ['a', 'b']) {
    const path = `${out}/${name}.json`
    await writeFile(path, JSON.stringify({ ...config, outDir: name }))
    await exec(process.execPath, ['src/cli.mjs', 'run', path])
    const summary = await readFile(`${out}/${name}/summary.json`, 'utf8')
    const report = JSON.parse(summary)
    assert.equal(report.participants.length, 1); assert.equal(report.groups[0].failed, 0)
    assert.equal(report.groups[0].caseMetrics.counterVisibleMs.n, 2)
    assert.equal(report.groups[0].windowWsApplicationBytes.p50, 0)
    assert.equal(report.groups[0].pageTaskCpuMs.length, 1)
    const raw = (await readFile(`${out}/${name}/operations.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(raw.every(sample => sample.result.submit.isTrusted && sample.requestsAtCutoff.some(r => r.direct && r.status === 200)))
    await exec(process.execPath, ['src/cli.mjs', 'report', `${out}/${name}`])
    assert.equal(await readFile(`${out}/${name}/summary.json`, 'utf8'), summary)
  }
  await exec(process.execPath, ['src/cli.mjs', 'compare', `${out}/a`, `${out}/b`])
  assert.equal(JSON.parse(await readFile(`${out}/b/comparison.json`, 'utf8')).sameVersionControl, true)
  const path = `${out}/invalid.json`
  await writeFile(path, JSON.stringify({ ...config, samples: 3, outDir: 'invalid' }))
  const invalidConfig = await loadConfig(path), invalid = resolveCase(invalidConfig), finish = invalid.finish
  let index = 0
  invalid.finish = args => {
    const result = finish(args)
    if (index === 0) result.submit = null
    else if (index === 1) result.submit.isTrusted = false
    else result.submit.role = 999
    index++
    return result
  }
  const rejected = await runBrowserBenchmark(invalidConfig, invalid)
  assert.equal(rejected.groups[0].failed, 3)
  assert.equal(rejected.groups[0].caseMetrics.counterVisibleMs.n, 0)
  const invalidRaw = (await readFile(`${out}/invalid/operations.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(invalidRaw.every(sample => sample.error === 'invalid-trusted-submit'))
  console.log(JSON.stringify({ pass: true, output: out, validSamples: 4, invalidSubmitsRejected: 3, reportRebuildExact: true, comparison: 'A/A' }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
