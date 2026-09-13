import test from 'node:test'
import assert from 'node:assert/strict'
import { observeD1, jsonBytes } from '../src/d1-observer.mjs'
import { observeWorker } from '../src/worker-observer.mjs'

function fixture() {
  const calls = []
  const database = {
    prepare(sql) {
      return {
        bind(...args) { calls.push(['bind', args]); return this },
        async raw() { calls.push(['raw', sql]); return [['same', 'same', new Uint8Array([0, 255])]] },
        async first() { calls.push(['first']); return { meta: { rows_read: 999 }, value: 'literal user row' } },
        async run() { calls.push(['run']); return { success: true, results: [], meta: { duration: 2, rows_read: 4, rows_written: 3, total_attempts: 2 } } },
      }
    },
    withSession(value) { calls.push(['session', value]); return this },
    getBookmark() { return 'bookmark' },
    async batch(statements) { calls.push(['batch', statements.length]); return statements.map(() => ({ success: true, results: [], meta: { duration: 1, rows_read: 2, rows_written: 1 } })) },
    async exec() { return { count: 3, duration: 7 } },
  }
  return { database, calls }
}

test('prepare/bind/session are not executions; raw keeps duplicate columns and binary result', async () => {
  const { database, calls } = fixture()
  const events = []
  const db = observeD1(database, event => events.push(event))
  const session = db.withSession('first-primary')
  const stmt = session.prepare('SELECT ? AS same, ? AS same').bind('a', 'b')
  assert.equal(events.length, 0)
  assert.equal(session.getBookmark(), 'bookmark')
  assert.deepEqual(await stmt.raw(), [['same', 'same', new Uint8Array([0, 255])]])
  assert.equal(events.length, 1)
  assert.equal(events[0].statements, 1)
  assert.equal(events[0].metadata[0].rowsRead, null)
  assert.equal(calls.filter(c => c[0] === 'raw').length, 1)
  assert.equal(calls.some(c => c[0] === 'run'), false)
})

test('batch is one original call with N original bound statements; preserves meta', async () => {
  const { database, calls } = fixture()
  const events = []
  const db = observeD1(database, event => events.push(event))
  const result = await db.batch([db.prepare('INSERT x').bind(1), db.prepare('INSERT y').bind(null)])
  assert.equal(result.length, 2)
  assert.equal(events.length, 1)
  assert.equal(events[0].statements, 2)
  assert.equal(events[0].metadata.length, 2)
  assert.equal(calls.filter(c => c[0] === 'batch').length, 1)
  await db.prepare('SELECT x').first()
  assert.equal(events[1].metadata[0].rowsRead, null)
  await db.prepare('UPDATE x').run()
  assert.equal(events[2].metadata[0].internalAttempts, 2)
  await db.exec('multiple statements')
  assert.equal(events[3].statements, null)
  assert.equal(events[3].reportedExecCount, 3)
})

test('failure remains same error and reports one failed call, unknown meta', async () => {
  const error = new Error('constraint')
  const database = { batch: async () => { throw error }, prepare: () => ({}) }
  const events = []
  const db = observeD1(database, e => events.push(e))
  await assert.rejects(db.batch([db.prepare('INSERT')]), e => e === error)
  assert.equal(events.length, 1)
  assert.equal(events[0].ok, false)
  assert.deepEqual(events[0].metadata, [])
})

test('binary encodings are explicit; unicode bytes and unsupported values are honest', () => {
  assert.equal(jsonBytes('你'), 5)
  assert.equal(jsonBytes(new Uint8Array([0, 255])), Buffer.byteLength(JSON.stringify({ binaryBase64: 'AP8=' })))
  assert.equal(jsonBytes(new Uint8Array([0, 255]).buffer), jsonBytes(new Uint8Array([0, 255])))
  assert.equal(jsonBytes(1n), null)
})

test('worker keeps response independent of background tasks, isolates simultaneous requests', async () => {
  const events = []
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const worker = observeWorker({ async fetch(_req, env, ctx) {
    await env.DB.prepare('one').run()
    ctx.waitUntil((async () => { await barrier; await env.DB.prepare('two').run() })())
    return new Response('ok')
  } }, e => events.push(e))
  const tasks = []
  const context = { waitUntil: task => tasks.push(task) }
  await Promise.all(['r1', 'r2'].map(requestId => worker.fetch(new Request('http://local/', { headers: { 'x-alook-benchmark-id': requestId } }), { DB: fixture().database }, context)))
  assert.equal(events.filter(e => e.kind === 'request-complete').length, 0)
  release()
  await Promise.all(tasks)
  for (const id of ['r1', 'r2']) {
    const records = events.filter(e => e.requestId === id)
    assert.equal(records.filter(e => e.kind === 'd1').length, 2)
    assert.deepEqual(records.filter(e => e.kind === 'd1').map(e => e.startedAfterResponse), [false, true])
    assert.equal(records.at(-1).kind, 'request-complete')
  }
})

test('a DB call spanning the response keeps both phase boundaries', async () => {
  const events = []
  let release
  let afterResponse = false
  const barrier = new Promise(resolve => { release = resolve })
  const db = observeD1({ prepare: () => ({ raw: () => barrier }) }, e => events.push(e), () => performance.now(), () => afterResponse)
  const call = db.prepare('SELECT').raw()
  afterResponse = true
  release([[1]])
  await call
  assert.equal(events[0].startedAfterResponse, false)
  assert.equal(events[0].completedAfterResponse, true)
})

test('unmarked requests pass original binding/context identity through untouched', async () => {
  const env = { DB: fixture().database }
  const ctx = { waitUntil() {} }
  let passed = false
  const worker = observeWorker({ fetch(_request, receivedEnv, receivedContext) {
    assert.equal(receivedEnv, env)
    assert.equal(receivedContext, ctx)
    passed = true
    return new Response('ok')
  } }, () => assert.fail('must not emit'))
  await worker.fetch(new Request('http://local'), env, ctx)
  assert.ok(passed)
})
