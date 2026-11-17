import { AsyncLocalStorage } from 'node:async_hooks'

export const querySource = new AsyncLocalStorage()
const origins = new WeakMap()
const wrapped = new WeakSet()
export const sourceHook = Symbol.for('alook.db-query-check.source')

export function registerQuerySource(builder, site) {
  if (!builder || typeof builder !== 'object' || !Object.isExtensible(builder)) return builder
  origins.set(builder, site)
  if (wrapped.has(builder)) return builder
  wrapped.add(builder)
  for (const method of ['_prepare', 'toSQL', 'bind', 'all', 'get', 'run', 'first', 'raw', 'execute']) {
    if (typeof builder[method] !== 'function') continue
    const original = builder[method]
    builder[method] = function (...args) {
      return querySource.run(origins.get(this), () => {
        const result = original.apply(this, args)
        return method === 'bind' ? registerQuerySource(result, origins.get(this)) : result
      })
    }
  }
  return builder
}

export function instrumentSource(code, sites) {
  const inserts = []
  for (const site of sites) {
    inserts.push([site.start, `globalThis[Symbol.for('alook.db-query-check.source')](`])
    inserts.push([site.builderEnd, `,${JSON.stringify({ key: site.key, file: site.file, line: site.line })})`])
  }
  for (const [position, text] of inserts.sort((a, b) => b[0] - a[0])) code = code.slice(0, position) + text + code.slice(position)
  return code
}
