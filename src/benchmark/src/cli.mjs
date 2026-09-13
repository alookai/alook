import { readFile, writeFile } from 'node:fs/promises'
import { loadConfig } from './config.mjs'
import { prepareFixture } from './client.mjs'
import { runBrowserBenchmark } from './browser-runner.mjs'
import { browserSummary, browserMarkdown } from './browser-report.mjs'
import { runBenchmark } from './runner.mjs'
import { summarize, markdown } from './report.mjs'
import { compareReports, comparisonMarkdown } from './compare.mjs'
import { generateAdapter } from './adapter.mjs'

async function main(args) {
  const [command, path, third] = args
  if (command === 'run' || command === 'calibrate') {
    const config = await loadConfig(path)
    const report = await (command === 'run' ? runBrowserBenchmark : runBenchmark)(config)
    console.log(JSON.stringify({ runId: report.runId, output: config.outDir, groups: report.groups.length, db: report.db.status }))
  } else if (command === 'compare') {
    const base = JSON.parse(await readFile(`${path}/summary.json`, 'utf8'))
    const head = JSON.parse(await readFile(`${third}/summary.json`, 'utf8'))
    const report = compareReports(base, head)
    await writeFile(`${third}/comparison.json`, JSON.stringify(report, null, 2))
    await writeFile(`${third}/comparison.md`, comparisonMarkdown(report))
    console.log(JSON.stringify({ output: `${third}/comparison.md`, sameVersionControl: report.sameVersionControl }))
  } else if (command === 'setup') {
    const config = await loadConfig(path)
    if (config.fixture.serverId || config.fixture.channelId) throw new Error('Fixture already references a server/channel; setup will not overwrite it')
    await prepareFixture(config, true)
    const { resolve, dirname } = await import('node:path')
    await writeFile(resolve(dirname(path), config.fixtureFile), JSON.stringify(config.fixture, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ serverId: config.fixture.serverId, channelId: config.fixture.channelId }))
  } else if (command === 'accounts') {
    const [baseUrl, output, countArg = '100'] = args.slice(1)
    const url = new URL(baseUrl)
    const count = Number(countArg)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Automatic dev account creation requires a local target')
    if (!Number.isInteger(count) || count < 2 || count > 1000 || !process.env.BENCHMARK_PASSWORD) throw new Error('Set BENCHMARK_PASSWORD and count 2..1000')
    const { randomUUID } = await import('node:crypto')
    const stamp = randomUUID().slice(0, 8)
    const accounts = []
    for (let i = 0; i < count; i++) {
      const response = await fetch(new URL('/api/auth/sign-up/email', url), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin },
        body: JSON.stringify({ name: `bench-${stamp}-${i}`, email: `bench-${stamp}-${i}@alook.test`, password: process.env.BENCHMARK_PASSWORD }),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      })
      if (!response.ok) throw new Error(`Account creation ${i} failed (${response.status}); partial fixture retained`)
      const data = await response.json()
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.startsWith('is_new_signup=')).join('; ')
      if (!cookie || !data.user?.id) throw new Error('Sign-up did not return an authenticated fixture')
      accounts.push({ userId: data.user.id, cookie })
      await writeFile(output, JSON.stringify({ accounts }, null, 2), { mode: 0o600 })
    }
    console.log(JSON.stringify({ accounts: accounts.length, fixture: output }))
  } else if (command === 'adapter') {
    if (!path || !third) throw new Error('adapter requires target Worker entry and generated output path')
    await generateAdapter(path, third)
    console.log('Generated test-only Worker entry; run it with the target runtime/configuration.')
  } else if (command === 'report') {
    const metadata = JSON.parse(await readFile(`${path}/metadata.json`, 'utf8'))
    const isBrowser = metadata.kind === 'browser-user-operation'
    const samples = (await readFile(`${path}/${isBrowser ? 'operations' : 'samples'}.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const telemetry = []
    const ownedIds = new Set(samples.flatMap(sample => isBrowser ? sample.requests.map(r => r.id) : [sample.requestId, sample.history?.requestId].filter(Boolean)))
    if (third) {
      for (const line of (await readFile(third, 'utf8')).split('\n')) {
        const start = line.indexOf('{')
        if (start < 0) continue
        try {
          const event = JSON.parse(line.slice(start))
          if (event.benchmark === 1 && ownedIds.has(event.requestId) && ['d1', 'request-start', 'response', 'request-complete'].includes(event.kind)) telemetry.push(event)
        } catch {}
      }
    }
    const report = (isBrowser ? browserSummary : summarize)(samples, metadata, telemetry)
    await writeFile(`${path}/db.jsonl`, telemetry.map(event => JSON.stringify(event)).join('\n') + '\n')
    await writeFile(`${path}/summary.json`, JSON.stringify(report, null, 2))
    await writeFile(`${path}/summary.md`, (isBrowser ? browserMarkdown : markdown)(report))
    console.log(JSON.stringify({ db: report.db.status, calls: report.db.executionCalls, completed: report.db.completedRequests, expected: report.db.expectedRequests }))
  } else {
    console.log('Usage: node src/cli.mjs run CONFIG | calibrate CONFIG | compare BASE_ARTIFACT_DIR HEAD_ARTIFACT_DIR | setup CONFIG | accounts LOCAL_URL FIXTURE_FILE [COUNT] | adapter TARGET_ENTRY OUTPUT | report ARTIFACT_DIR [WORKER_LOG_JSONL]')
    if (command && command !== 'help' && command !== '--help') process.exitCode = 1
  }
}

main(process.argv.slice(2)).then(() => { process.exit(process.exitCode ?? 0) }, error => { console.error(error.message); process.exit(1) })
