import { MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared/constants/community"
import { promisifyRequest } from "idb-keyval"
import { cacheTransaction } from "@/lib/query-cache-store"
import {
  channelFenceKey,
  isPersistedChannelFences,
  readPersistedAccountClaim,
  type AccountIdentityRecord,
} from "@/lib/persisted-account-identity"

const CACHE_PREFIX = "alook:video-preview:"
const PREFIX = `${CACHE_PREFIX}v1:`
const MAX_ENTRIES = 32
const MAX_MEMORY_DIMENSION_ENTRIES = 256

export type VideoDimensions = { width: number; height: number }
const videoMemoryDimensions = new WeakMap<object, { epoch: number; entries: Map<string, VideoDimensions> }>()
let videoMemoryEpoch = 0

export function invalidateVideoMemoryDimensionsCache(): void {
  videoMemoryEpoch += 1
}

function getVideoMemoryMap(scope: object): Map<string, VideoDimensions> {
  const existing = videoMemoryDimensions.get(scope)
  if (existing && existing.epoch === videoMemoryEpoch) return existing.entries
  const entries = new Map<string, VideoDimensions>()
  videoMemoryDimensions.set(scope, { epoch: videoMemoryEpoch, entries })
  return entries
}

export function readVideoMemoryDimensions(scope: object | null | undefined, url: string): VideoDimensions | null {
  if (!scope) return null
  const map = getVideoMemoryMap(scope)
  const dims = map.get(url)
  if (!dims) return null
  map.delete(url)
  map.set(url, dims)
  return dims
}

export function writeVideoMemoryDimensions(scope: object | null | undefined, url: string, dims: VideoDimensions): void {
  if (!scope || !dimensions(dims)) return
  const map = getVideoMemoryMap(scope)
  map.delete(url)
  map.set(url, { width: dims.width, height: dims.height })
  if (map.size > MAX_MEMORY_DIMENSION_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

export type VideoPreviewOwner = Pick<AccountIdentityRecord, "id" | "version" | "device" | "account" | "scope"> & {
  channelId: string
  channelEpoch: string | undefined
}
export type VideoPreview = { width: number; height: number; poster?: Blob }
type StoredPreview = VideoPreview & { version: 1; owner: VideoPreviewOwner; url: string; savedAt: number }

function channelFor(url: string): string | undefined {
  if (url.length > 4096) return undefined
  try {
    const parsed = new URL(url, "https://alook.invalid")
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    const match = /^\/api\/community\/channels\/([^/]+)\/attachments\/[^/]+$/.exec(parsed.pathname)
    return match ? decodeURIComponent(match[1]!) : undefined
  } catch { return undefined }
}

function keyFor(id: string, url: string) { return `${PREFIX}${encodeURIComponent(id)}:${encodeURIComponent(url)}` }
export function isVideoPreviewCacheKey(key: IDBValidKey, accountId?: string | null): key is string {
  if (typeof key !== "string") return false
  const match = /^alook:video-preview:v\d+:([^:]+):(.+)$/.exec(key)
  return Boolean(match && (accountId === undefined || accountId !== null && match[1] === encodeURIComponent(accountId)))
}
function sameOwner(a: VideoPreviewOwner, b: VideoPreviewOwner) {
  return a.id === b.id && a.version === b.version && a.device === b.device && a.account === b.account
    && a.scope === b.scope && a.channelId === b.channelId && a.channelEpoch === b.channelEpoch
}
function dimensions(value: VideoPreview) {
  return Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 65535
    && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 65535
}
function posterValid(value: unknown): value is Blob | undefined {
  return value === undefined || value instanceof Blob && value.type === "image/jpeg"
    && value.size > 0 && value.size <= MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
}
function storedPreview(value: unknown, owner: VideoPreviewOwner, url: string): StoredPreview | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as StoredPreview
  return row.version === 1 && row.url === url && row.owner && sameOwner(row.owner, owner)
    && dimensions(row) && posterValid(row.poster) && Number.isFinite(row.savedAt) && row.savedAt >= 0 ? row : undefined
}
async function currentOwner(store: IDBObjectStore, accountId: string, channelId: string): Promise<VideoPreviewOwner | null> {
  const claim = await readPersistedAccountClaim(store)
  if (!claim || claim.id !== accountId) return null
  const fences = await promisifyRequest<unknown>(store.get(channelFenceKey(accountId)))
  if (!isPersistedChannelFences(fences) || fences.get(channelId)?.deleted) return null
  return { id: claim.id, version: claim.version, device: claim.device, account: claim.account,
    scope: claim.scope, channelId, channelEpoch: fences.get(channelId)?.epoch }
}
async function eligible(store: IDBObjectStore, owner: VideoPreviewOwner, url: string) {
  if (channelFor(url) !== owner.channelId) return false
  const current = await currentOwner(store, owner.id, owner.channelId)
  return current !== null && sameOwner(current, owner)
}

export async function captureVideoPreviewOwner(accountId: string, url: string): Promise<VideoPreviewOwner | null> {
  const channelId = channelFor(url)
  if (!channelId) return null
  try { return await cacheTransaction("readonly", store => currentOwner(store, accountId, channelId)) }
  catch { return null }
}
export async function readVideoPreview(owner: VideoPreviewOwner, url: string): Promise<VideoPreview | null> {
  try {
    return await cacheTransaction("readwrite", async store => {
      if (!await eligible(store, owner, url)) return null
      const key = keyFor(owner.id, url)
      const raw = await promisifyRequest<unknown>(store.get(key))
      const row = storedPreview(raw, owner, url)
      if (!row) { if (raw !== undefined) store.delete(key); return null }
      store.put({ ...row, savedAt: Date.now() }, key)
      return { width: row.width, height: row.height, poster: row.poster }
    })
  } catch { return null }
}
export async function saveVideoPreview(owner: VideoPreviewOwner, url: string, preview: VideoPreview): Promise<boolean> {
  if (!dimensions(preview) || !posterValid(preview.poster)) return false
  try {
    return await cacheTransaction("readwrite", async store => {
      if (!await eligible(store, owner, url)) return false
      const key = keyFor(owner.id, url)
      const previous = storedPreview(await promisifyRequest<unknown>(store.get(key)), owner, url)
      const row: StoredPreview = { ...preview, poster: preview.poster ?? previous?.poster, version: 1, owner, url, savedAt: Date.now() }
      store.put(row, key)
      const entries = await new Promise<Array<{ key: IDBValidKey; time: number }>>((resolve, reject) => {
        const result: Array<{ key: IDBValidKey; time: number }> = []
        const request = store.openCursor(IDBKeyRange.bound(CACHE_PREFIX, `${CACHE_PREFIX}\uffff`))
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) { resolve(result); return }
          if (isVideoPreviewCacheKey(cursor.key)) {
            const value = cursor.value as Partial<StoredPreview> | null
            result.push({ key: cursor.key, time: typeof value?.savedAt === "number" ? value.savedAt : 0 })
          }
          cursor.continue()
        }
      })
      entries.sort((a, b) => a.time - b.time || (a.key === key ? 1 : b.key === key ? -1 : 0))
      for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) store.delete(entry.key)
      return true
    })
  } catch { return false }
}

export async function clearVideoPreviewChannels(store: IDBObjectStore, accountId: string | null, channelIds: readonly string[]) {
  invalidateVideoMemoryDimensionsCache()
  const channels = new Set(channelIds)
  await new Promise<void>((resolve, reject) => {
    const request = store.openKeyCursor(IDBKeyRange.bound(CACHE_PREFIX, `${CACHE_PREFIX}\uffff`))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      if (isVideoPreviewCacheKey(cursor.key, accountId)) {
        try {
          const encodedUrl = cursor.key.slice(cursor.key.lastIndexOf(":") + 1)
          const channel = channelFor(decodeURIComponent(encodedUrl))
          if (channel && channels.has(channel)) store.delete(cursor.primaryKey)
        } catch {}
      }
      cursor.continue()
    }
  })
}
export function videoPreviewSizeBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0
  const record = value as Partial<StoredPreview>
  const posterBytes = record.poster instanceof Blob ? record.poster.size : 0
  try { return posterBytes + new TextEncoder().encode(JSON.stringify({ ...record, poster: undefined })).byteLength }
  catch { return posterBytes }
}
