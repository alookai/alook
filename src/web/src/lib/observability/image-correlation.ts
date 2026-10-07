let sequence = 0
let objects = new WeakMap<object, string>()
const sources = new Map<string, string>()
const LIMIT = 512
let evictions = 0

export function observationObjectId(value: object) {
  let id = objects.get(value)
  if (!id) { id = `o${++sequence}`; objects.set(value, id) }
  return id
}

export function imageSourceId(value: string | undefined) {
  if (!value || value.length > 4096) return undefined
  let key: string
  try { key = new URL(value, typeof window === "undefined" ? "https://alook.ai" : window.location.href).href } catch { return undefined }
  let id = sources.get(key)
  if (!id) {
    if (sources.size >= LIMIT) { sources.delete(sources.keys().next().value!); evictions++ }
    id = `s${++sequence}`
    sources.set(key, id)
  }
  return id
}

export function imageCorrelationSnapshot() { return { correlation_evictions: evictions, correlation_size: sources.size } }
export function hasImageSource(value: string) {
  try { return sources.has(new URL(value, typeof window === "undefined" ? "https://alook.ai" : window.location.href).href) } catch { return false }
}
export function clearImageCorrelations() { sources.clear(); evictions = 0; objects = new WeakMap() }
