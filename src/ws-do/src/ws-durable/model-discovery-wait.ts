import { fingerprintRuntimeModelCatalog, type RuntimeModelDiscoveryRequest, type RuntimeModelDiscoveryResult } from "@alook/shared"
import type { WsDurableContext } from "./internal"

const PREFIX = "model-discovery-wait:"
const RESULT_PREFIX = "model-discovery-result:"
const CACHE_PREFIX = "model-discovery-cache:"
const CACHE_MS = 5 * 60_000
const MAX_CACHED = 64
const MAX_PENDING = 16
const WAIT_MS = 45_000
const MAX_RESULT_BYTES = 2_000_000

type Pending = { runtimeId: string; expiresAt: number; completed?: boolean; observedAt?: number }
type Cached = { observedAt: number; catalogFingerprint: string }
const resultKey = (requestId: string) => RESULT_PREFIX + requestId

export async function waitForModelDiscovery(
  context: WsDurableContext,
  command: RuntimeModelDiscoveryRequest,
  dispatch: () => { sent: number; unsupported: number },
  options: { useCache?: boolean; catalogFingerprint?: string } = {},
) {
  const storage = context.ctx.storage
  const key = PREFIX + command.requestId
  const now = Date.now()
  if (options.useCache) {
    const cached = await storage.get<Cached>(CACHE_PREFIX + command.runtimeId)
    if (cached && options.catalogFingerprint && cached.catalogFingerprint === options.catalogFingerprint && cached.observedAt <= now && now - cached.observedAt < CACHE_MS) {
      return { sent: 0, unsupported: 0, cached: true, observedAt: new Date(cached.observedAt).toISOString(), catalogFingerprint: cached.catalogFingerprint }
    }
  }
  await storage.transaction(async (txn) => {
    const entries = await txn.list<Pending>({ prefix: PREFIX })
    for (const [entryKey, pending] of entries) {
      if (pending.expiresAt <= now) {
        await txn.delete([entryKey, resultKey(entryKey.slice(PREFIX.length))])
        entries.delete(entryKey)
      }
    }
    if (entries.has(key) || entries.size >= MAX_PENDING) throw new Error("Model discovery is busy")
    await txn.put<Pending>(key, { runtimeId: command.runtimeId, expiresAt: now + WAIT_MS })
  })
  try {
    const receipt = dispatch()
    if (receipt.sent === 0) return receipt
    while (Date.now() < now + WAIT_MS) {
      const pending = await storage.get<Pending>(key)
      if (!pending) break
      if (pending.completed) {
        const bytes = await storage.get<Uint8Array>(resultKey(command.requestId))
        if (bytes === undefined) throw new Error("Model discovery result unavailable")
        return { ...receipt, cached: false, observedAt: new Date(pending.observedAt!).toISOString(), result: JSON.parse(new TextDecoder().decode(bytes)) as RuntimeModelDiscoveryResult }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { ...receipt, result: { status: "error" as const, code: "MODEL_DISCOVERY_TIMEOUT", message: "Model discovery timed out" } }
  } finally {
    await storage.transaction(async (txn) => {
      const pending = await txn.get<Pending>(key)
      if (pending?.expiresAt === now + WAIT_MS) await txn.delete([key, resultKey(command.requestId)])
    })
  }
}

export async function completeModelDiscoveryWait(
  context: WsDurableContext,
  requestId: string,
  runtimeId: string,
  result: RuntimeModelDiscoveryResult,
) {
  const storage = context.ctx.storage
  const key = PREFIX + requestId
  if (!await storage.get<Pending>(key)) return
  const recordKey = resultKey(requestId)
  const encoder = new TextEncoder()
  let saved = result
  let bytes = encoder.encode(JSON.stringify(saved))
  if (encoder.encode(recordKey).byteLength + bytes.byteLength > MAX_RESULT_BYTES) {
    saved = { status: "error", code: "MODEL_DISCOVERY_RESULT_TOO_LARGE", message: "Model discovery result is too large" }
    bytes = encoder.encode(JSON.stringify(saved))
  }
  const catalogFingerprint = saved.status === "complete" ? await fingerprintRuntimeModelCatalog(saved.catalog) : undefined
  await storage.transaction(async (txn) => {
    const pending = await txn.get<Pending>(key)
    if (!pending || pending.runtimeId !== runtimeId || pending.expiresAt <= Date.now() || pending.completed) return
    const observedAt = Date.now()
    await txn.put(recordKey, bytes)
    if (catalogFingerprint) {
      const entries = await txn.list<Cached>({ prefix: CACHE_PREFIX })
      for (const [cacheKey, cached] of entries) {
        if (observedAt - cached.observedAt >= CACHE_MS || cached.observedAt > observedAt) {
          await txn.delete(cacheKey)
          entries.delete(cacheKey)
        }
      }
      if (!entries.has(CACHE_PREFIX + runtimeId) && entries.size >= MAX_CACHED) {
        const oldest = [...entries].sort((a, b) => a[1].observedAt - b[1].observedAt)[0]
        await txn.delete(oldest[0])
      }
      await txn.put<Cached>(CACHE_PREFIX + runtimeId, { catalogFingerprint, observedAt })
    }
    await txn.put<Pending>(key, { ...pending, completed: true, observedAt })
  })
}
