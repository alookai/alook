import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { runBrowserBenchmark } from '../src/browser-runner.mjs'
import { httpCounterControl } from '../src/cases/http-counter-control.mjs'

const config = outDir => ({ outDir, concurrency: 1, phases: [], baseUrl: 'http://fixture.test', timeoutMs: 1000 })

test('browser entry rejects an occupied directory before launch and preserves the original artifacts', async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'browser-owned-run-'))
  const launch = t.mock.method(chromium, 'launch', async () => { throw new Error('must not launch') })
  try {
    await writeFile(join(outDir, 'metadata.json'), 'prior metadata bytes')
    await assert.rejects(runBrowserBenchmark(config(outDir), httpCounterControl(config(outDir))), /Output directory must be empty/)
    assert.equal(await readFile(join(outDir, 'metadata.json'), 'utf8'), 'prior metadata bytes')
    assert.equal(launch.mock.callCount(), 0)
  } finally { await rm(outDir, { recursive: true, force: true }) }
})

for (const fault of ['metadata', 'write']) test(`browser closes exactly once after early ${fault} failure`, async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'browser-setup-fail-'))
  const failure = new Error('metadata fixture failure')
  const close = t.mock.fn(async () => {})
  t.mock.method(chromium, 'launch', async () => {
    if (fault === 'write') await mkdir(join(outDir, 'metadata.json'))
    return { close, version() { if (fault === 'metadata') throw failure; return 'fixture-browser' } }
  })
  try {
    const pending = runBrowserBenchmark(config(outDir), httpCounterControl(config(outDir)))
    if (fault === 'metadata') await assert.rejects(pending, error => error === failure)
    else await assert.rejects(pending, error => error.code === 'EISDIR')
    assert.equal(close.mock.callCount(), 1)
  } finally { await rm(outDir, { recursive: true, force: true }) }
})
