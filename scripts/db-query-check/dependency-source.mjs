import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyNativeBindings, nativeBindingSupported } from './source-context.mjs'

export const dependencyQuery = new AsyncLocalStorage()

function callSites(before) {
  const original = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_error, frames) => frames
    const error = {}
    Error.captureStackTrace(error, before)
    return error.stack
  } finally {
    Error.prepareStackTrace = original
  }
}

function frameFile(frame) {
  const file = frame?.getFileName()
  return file?.startsWith('file:') ? fileURLToPath(file) : file
}

function location(frame, packageRoot) {
  return { file: relative(packageRoot, frameFile(frame)).replaceAll('\\', '/'), line: frame.getLineNumber(), column: frame.getColumnNumber() }
}

export async function instrumentBetterAuthQueries(root) {
  const webRequire = createRequire(join(root, 'src/web/package.json'))
  const authRequire = createRequire(webRequire.resolve('better-auth'))
  const packageName = '@better-auth/kysely-adapter'
  const adapterEntry = authRequire.resolve(packageName)
  const driverEntry = authRequire.resolve(`${packageName}/node-sqlite-dialect`)
  const adapterRoot = dirname(dirname(adapterEntry))
  const manifest = JSON.parse(readFileSync(join(adapterRoot, 'package.json'), 'utf8'))
  if (manifest.name !== packageName || typeof manifest.version !== 'string') throw new Error('Unexpected Better Auth query adapter')
  const engine = createRequire(adapterEntry).resolve('kysely')
  const builderDir = join(dirname(engine), 'query-builder')
  const { DefaultQueryExecutor } = await import(pathToFileURL(engine))
  const prototype = DefaultQueryExecutor.prototype
  const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, 'executeQuery')
  const execute = prototype.executeQuery
  prototype.executeQuery = function traceQuery(query, ...args) {
    let evidence
    if (typeof query?.sql === 'string' && Array.isArray(query.parameters) && query.parameters.every(nativeBindingSupported)) {
      const [builder, producer] = callSites(traceQuery)
      const builderFile = frameFile(builder)
      if (builderFile && dirname(builderFile) === builderDir && builder.getMethodName() === 'execute' && frameFile(producer) === adapterEntry) {
        evidence = { sql: query.sql, params: copyNativeBindings(query.parameters), driverEntry, adapterRoot,
          origin: { package: manifest.name, version: manifest.version, construction: location(producer, adapterRoot) } }
      }
    }
    return dependencyQuery.run(evidence, () => execute.call(this, query, ...args))
  }
  return () => {
    if (originalDescriptor) Object.defineProperty(prototype, 'executeQuery', originalDescriptor)
    else delete prototype.executeQuery
  }
}

export function dependencyPrepare(sql, before) {
  const query = dependencyQuery.getStore()
  if (!query || query.sql !== sql) return undefined
  const [driver] = callSites(before)
  if (frameFile(driver) !== query.driverEntry) return undefined
  return { query, source: { ...query.origin, execution: location(driver, query.adapterRoot) } }
}
