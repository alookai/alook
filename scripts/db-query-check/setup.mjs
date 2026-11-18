import { afterAll } from 'vitest'
import { sourceHook, registerQuerySource } from './source-context.mjs'
import { batchSourceHook, prepareBatchStatement, createCapture, instrumentDatabase, nativeDatabasePrototypes } from './capture.mjs'

const directory = process.env.ALOOK_DB_QUERY_CAPTURE_DIR
if (!directory || !process.env.ALOOK_DB_QUERY_ROOT) throw new Error('DB query setup requires the checker command')
const previousHook = globalThis[sourceHook]
const previousBatchHook = globalThis[batchSourceHook]
globalThis[sourceHook] = registerQuerySource
globalThis[batchSourceHook] = prepareBatchStatement
const previousStackLimit = Error.stackTraceLimit
Error.stackTraceLimit = 100
const capture = createCapture(process.env.ALOOK_DB_QUERY_ROOT)
const restores = nativeDatabasePrototypes(process.env.ALOOK_DB_QUERY_ROOT).map(prototype => instrumentDatabase(prototype, query => capture.collect(query)))
afterAll(() => {
  for (const restore of restores.reverse()) restore()
  globalThis[sourceHook] = previousHook
  globalThis[batchSourceHook] = previousBatchHook
  Error.stackTraceLimit = previousStackLimit
  capture.write(directory)
})
