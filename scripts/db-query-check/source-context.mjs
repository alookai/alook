import { AsyncLocalStorage } from 'node:async_hooks'
import { relative } from 'node:path'

export const querySource = new AsyncLocalStorage()
const origins = new WeakMap()
const wrapped = new WeakSet()
const wrappedSessions = new WeakSet()
const wrappedCompilers = new WeakSet()
const fragmentOrigins = new WeakMap()
export const sourceHook = Symbol.for('alook.db-query-check.source')

export function queryOrigin(builder) {
  return origins.get(builder)
}

function trackSqlFragment(fragment, source) {
  const compiler = fragment && Object.getPrototypeOf(fragment)
  if (!source || source.kind === 'test-fixture' || !Array.isArray(fragment?.queryChunks) ||
      typeof compiler?.toQuery !== 'function' || typeof compiler?.buildQueryFromSourceParams !== 'function') return
  fragmentOrigins.set(fragment.queryChunks, source.key)
  if (wrappedCompilers.has(compiler)) return
  wrappedCompilers.add(compiler)
  const toQuery = compiler.toQuery
  const build = compiler.buildQueryFromSourceParams
  compiler.toQuery = function (...args) {
    const source = querySource.getStore()
    if (!source || source.kind === 'test-fixture') return toQuery.apply(this, args)
    const consumed = new Set()
    const result = querySource.run({ ...source, consumed }, () => toQuery.apply(this, args))
    source.compiled = { sql: result.sql, siteKeys: [...consumed].filter(key => key !== source.key) }
    return result
  }
  compiler.buildQueryFromSourceParams = function (chunks, config) {
    const key = fragmentOrigins.get(chunks)
    if (key) querySource.getStore()?.consumed?.add(key)
    return build.call(this, chunks, config)
  }
}

export function registerQuerySource(builder, site) {
  if (!builder || typeof builder !== 'object' || !Object.isExtensible(builder)) return builder
  origins.set(builder, site)
  const session = builder.session
  if (site?.kind === 'test-fixture' && site.proof === 'orm-builder' && session && !wrappedSessions.has(session)) {
    wrappedSessions.add(session)
    for (const method of ['prepareQuery', 'prepareOneTimeQuery']) {
      if (typeof session[method] !== 'function') continue
      const original = session[method]
      session[method] = function (query, ...args) {
        const source = querySource.getStore()
        const invoke = () => original.call(this, query, ...args)
        return source?.kind === 'test-fixture' && source.proof === 'orm-builder' && typeof query?.sql === 'string' ? querySource.run({ ...source, preparedSql: query.sql }, invoke) : invoke()
      }
    }
  }
  if (wrapped.has(builder)) return builder
  wrapped.add(builder)
  if (typeof builder.getSQL === 'function') {
    const getSql = builder.getSQL
    builder.getSQL = function (...args) {
      const fragment = getSql.apply(this, args)
      trackSqlFragment(fragment, origins.get(this) ?? origins.get(builder))
      return fragment
    }
  }
  for (const method of ['_prepare', 'toSQL', 'bind', 'all', 'get', 'run', 'first', 'raw', 'execute']) {
    if (typeof builder[method] !== 'function') continue
    const original = builder[method]
    builder[method] = function (...args) {
      const source = origins.get(this) ?? origins.get(builder)
      return querySource.run(source && { ...source }, () => {
        const result = original.apply(this, args)
        return method === 'bind' ? registerQuerySource(result, source) : result
      })
    }
  }
  return builder
}

export function instrumentSource(code, sites) {
  const inserts = []
  for (const site of sites) {
    if (site.instrumentation === 'optional-chain-unverified') continue
    inserts.push([site.start, `globalThis[Symbol.for('alook.db-query-check.source')](`])
    inserts.push([site.builderEnd, `,${JSON.stringify({ key: site.key, file: site.file, line: site.line, kind: site.kind, proof: site.proof, literalSql: site.literalSql })})`])
  }
  for (const [position, text] of inserts.sort((a, b) => b[0] - a[0])) code = code.slice(0, position) + text + code.slice(position)
  return code
}

export function instrumentModule(code, id, root, sites) {
  const separator = id.indexOf('?')
  const query = new URLSearchParams(separator < 0 ? '' : id.slice(separator + 1))
  if (query.has('raw') || query.has('url')) return undefined
  const file = relative(root, separator < 0 ? id : id.slice(0, separator)).replaceAll('\\', '/')
  const matches = sites.filter(site => site.file === file && site.instrumentation !== 'optional-chain-unverified')
  return matches.length ? instrumentSource(code, matches) : undefined
}
