import { AsyncLocalStorage } from 'node:async_hooks'

export const querySource = new AsyncLocalStorage()
const origins = new WeakMap()
const wrapped = new WeakSet()
const wrappedSessions = new WeakSet()
export const sourceHook = Symbol.for('alook.db-query-check.source')

export function queryOrigin(builder) {
  return origins.get(builder)
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
  for (const method of ['_prepare', 'toSQL', 'bind', 'all', 'get', 'run', 'first', 'raw', 'execute']) {
    if (typeof builder[method] !== 'function') continue
    const original = builder[method]
    builder[method] = function (...args) {
      const source = origins.get(this) ?? origins.get(builder)
      return querySource.run(source, () => {
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
    inserts.push([site.start, `globalThis[Symbol.for('alook.db-query-check.source')](`])
    inserts.push([site.builderEnd, `,${JSON.stringify({ key: site.key, file: site.file, line: site.line, kind: site.kind, proof: site.proof, literalSql: site.literalSql })})`])
  }
  for (const [position, text] of inserts.sort((a, b) => b[0] - a[0])) code = code.slice(0, position) + text + code.slice(position)
  return code
}
