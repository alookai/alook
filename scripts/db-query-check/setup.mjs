import { afterAll } from 'vitest'
import { sourceHook } from './source-context.mjs'
import { batchSourceHook, prepareBatchStatement, createCapture, instrumentDatabase, nativeDatabasePrototypes } from './capture.mjs'
import { instrumentBetterAuthQueries } from './dependency-source.mjs'

const directory = process.env.ALOOK_DB_QUERY_CAPTURE_DIR
if (!directory || !process.env.ALOOK_DB_QUERY_ROOT) throw new Error('DB query setup requires the checker command')
const previousHook = globalThis[sourceHook]
const previousBatchHook = globalThis[batchSourceHook]
const capture = createCapture(process.env.ALOOK_DB_QUERY_ROOT)
globalThis[sourceHook] = capture.register
globalThis[batchSourceHook] = prepareBatchStatement
const previousStackLimit = Error.stackTraceLimit
Error.stackTraceLimit = 100
const restores = nativeDatabasePrototypes(process.env.ALOOK_DB_QUERY_ROOT).map(prototype => instrumentDatabase(prototype, query => capture.collect(query)))
if (process.env.ALOOK_DB_QUERY_AUTH_TRACE === '1') restores.push(await instrumentBetterAuthQueries(process.env.ALOOK_DB_QUERY_ROOT))
afterAll(() => {
  for (const restore of restores.reverse()) restore()
  globalThis[sourceHook] = previousHook
  globalThis[batchSourceHook] = previousBatchHook
  Error.stackTraceLimit = previousStackLimit
  capture.write(directory)
})
