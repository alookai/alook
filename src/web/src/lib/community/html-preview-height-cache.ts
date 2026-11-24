import type { QueryClient } from "@tanstack/react-query"
import { promisifyRequest } from "idb-keyval"
import { cacheTransaction } from "@/lib/query-cache-store"

const CACHE_PREFIX = "alook:html-preview-height:"
const PREFIX = `${CACHE_PREFIX}v1:`
const MAX_IDB_ENTRIES = 128
const MAX_MEMORY_ENTRIES = 256
const MIN_HTML_PREVIEW_HEIGHT = 80
const MAX_HTML_PREVIEW_HEIGHT = 2000

type StoredHtmlPreviewHeight = {
  version: 1
  height: number
  channelId?: string
  savedAt: number
}

const memoryCaches = new WeakMap<QueryClient, { epoch: number; entries: Map<string, number> }>()
let memoryCacheEpoch = 0

function clampHtmlPreviewHeight(value: number): number {
  return Math.max(MIN_HTML_PREVIEW_HEIGHT, Math.min(MAX_HTML_PREVIEW_HEIGHT, Math.ceil(value)))
}

function channelFor(url: string): string | undefined {
  if (url.length > 4096) return undefined
  try {
    const parsed = new URL(url, "https://alook.invalid")
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    const match = /^\/api\/community\/channels\/([^/]+)\/attachments\/[^/]+$/.exec(parsed.pathname)
    return match ? decodeURIComponent(match[1]!) : undefined
  } catch {
    return undefined
  }
}

function keyFor(accountId: string, url: string, attachmentId: string) {
  const channel = channelFor(url) ?? ""
  return `${PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(channel)}:${encodeURIComponent(attachmentId)}`
}

export function isHtmlPreviewHeightCacheKey(key: IDBValidKey, accountId?: string | null): key is string {
  if (typeof key !== "string") return false
  const match = /^alook:html-preview-height:v\d+:([^:]+):([^:]*):(.+)$/.exec(key)
  return Boolean(match && (accountId === undefined || accountId !== null && match[1] === encodeURIComponent(accountId)))
}

function channelFromKey(key: string): string | undefined {
  const match = /^alook:html-preview-height:v\d+:[^:]+:([^:]*):.+$/.exec(key)
  if (!match || !match[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

export function invalidateHtmlPreviewHeightMemoryCache(): void {
  memoryCacheEpoch += 1
}

function getMemoryMap(queryClient: QueryClient): Map<string, number> {
  const existing = memoryCaches.get(queryClient)
  if (existing && existing.epoch === memoryCacheEpoch) return existing.entries
  const entries = new Map<string, number>()
  memoryCaches.set(queryClient, { epoch: memoryCacheEpoch, entries })
  return entries
}

export function readHtmlPreviewMemoryHeight(queryClient: QueryClient, attachmentId: string): number | undefined {
  const map = getMemoryMap(queryClient)
  const height = map.get(attachmentId)
  if (height === undefined) return undefined
  map.delete(attachmentId)
  map.set(attachmentId, height)
  return height
}

export function writeHtmlPreviewMemoryHeight(queryClient: QueryClient, attachmentId: string, height: number): number {
  const clamped = clampHtmlPreviewHeight(height)
  const map = getMemoryMap(queryClient)
  map.delete(attachmentId)
  map.set(attachmentId, clamped)
  if (map.size > MAX_MEMORY_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  return clamped
}

function validStoredRecord(value: unknown): StoredHtmlPreviewHeight | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<StoredHtmlPreviewHeight>
  if (
    record.version !== 1
    || typeof record.height !== "number"
    || !Number.isFinite(record.height)
    || record.height < MIN_HTML_PREVIEW_HEIGHT
    || record.height > MAX_HTML_PREVIEW_HEIGHT
    || typeof record.savedAt !== "number"
    || !Number.isFinite(record.savedAt)
    || record.savedAt < 0
  ) {
    return undefined
  }
  return record as StoredHtmlPreviewHeight
}

export async function readHtmlPreviewHeight(
  accountId: string | null | undefined,
  attachmentId: string,
  url: string,
): Promise<number | null> {
  if (!accountId) return null
  try {
    return await cacheTransaction("readonly", async (store) => {
      const raw = await promisifyRequest<unknown>(store.get(keyFor(accountId, url, attachmentId)))
      const record = validStoredRecord(raw)
      return record ? clampHtmlPreviewHeight(record.height) : null
    })
  } catch {
    return null
  }
}

export async function saveHtmlPreviewHeight(
  accountId: string | null | undefined,
  attachmentId: string,
  url: string,
  height: number,
): Promise<boolean> {
  if (!accountId || !Number.isFinite(height) || height <= 0) return false
  const clamped = clampHtmlPreviewHeight(height)
  const key = keyFor(accountId, url, attachmentId)
  const row: StoredHtmlPreviewHeight = {
    version: 1,
    height: clamped,
    channelId: channelFor(url),
    savedAt: Date.now(),
  }
  try {
    return await cacheTransaction("readwrite", async (store) => {
      store.put(row, key)
      const entries = await new Promise<Array<{ key: IDBValidKey; time: number }>>((resolve, reject) => {
        const result: Array<{ key: IDBValidKey; time: number }> = []
        const request = store.openCursor(IDBKeyRange.bound(CACHE_PREFIX, `${CACHE_PREFIX}\uffff`))
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) { resolve(result); return }
          if (isHtmlPreviewHeightCacheKey(cursor.key)) {
            const value = cursor.value as Partial<StoredHtmlPreviewHeight> | null
            result.push({ key: cursor.key, time: typeof value?.savedAt === "number" ? value.savedAt : 0 })
          }
          cursor.continue()
        }
      })
      if (entries.length > MAX_IDB_ENTRIES) {
        entries.sort((a, b) => a.time - b.time || (a.key === key ? 1 : b.key === key ? -1 : 0))
        for (const entry of entries.slice(0, entries.length - MAX_IDB_ENTRIES)) store.delete(entry.key)
      }
      return true
    })
  } catch {
    return false
  }
}

export async function clearHtmlPreviewHeightChannels(
  store: IDBObjectStore,
  accountId: string | null,
  channelIds: readonly string[],
): Promise<void> {
  invalidateHtmlPreviewHeightMemoryCache()
  const channels = new Set(channelIds)
  await new Promise<void>((resolve, reject) => {
    const request = store.openKeyCursor(IDBKeyRange.bound(CACHE_PREFIX, `${CACHE_PREFIX}\uffff`))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      if (isHtmlPreviewHeightCacheKey(cursor.key, accountId)) {
        const channel = channelFromKey(cursor.key)
        if (channel && channels.has(channel)) store.delete(cursor.primaryKey)
      }
      cursor.continue()
    }
  })
}

export function htmlPreviewHeightSizeBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}
