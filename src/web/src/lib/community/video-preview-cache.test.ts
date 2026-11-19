import "fake-indexeddb/auto"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { get, keys, set } from "idb-keyval"
import * as storage from "@/lib/query-cache-store"
import { clearAllPersistedCaches, clearPersistedCache, createIdbPersister, getPersistedCacheSizeBytes } from "@/lib/query-persister"
import { MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES } from "@alook/shared/constants/community"
import { captureVideoPreviewOwner, isVideoPreviewCacheKey, readVideoPreview, saveVideoPreview } from "./video-preview-cache"

let account: string
let channel: string
let url: string
const poster = () => new Blob([new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4])], { type: "image/jpeg" })
async function qualified(id = account, source = url) {
  const persister = createIdbPersister(id)
  expect(await persister.isCurrent()).toBe(true)
  await persister.rememberAccountIdentity({ id, email: `${id}@example.test` }, () => {})
  const owner = await captureVideoPreviewOwner(id, source)
  if (!owner) throw new Error("Original account persister did not qualify the preview owner")
  return { persister, owner }
}
beforeEach(async () => {
  account = `video-${crypto.randomUUID()}`
  channel = crypto.randomUUID()
  url = `/api/community/channels/${channel}/attachments/clip`
  await clearAllPersistedCaches()
})
afterEach(() => { vi.restoreAllMocks() })

describe("derived video preview persistence", () => {
  it("commits dimensions and JPEG bytes then restores through a fresh qualified owner", async () => {
    const first = await qualified()
    const image = poster()
    expect(await saveVideoPreview(first.owner, url, { width: 640, height: 360, poster: image })).toBe(true)
    first.persister.stopPersisting()
    const second = await qualified()
    const restored = await readVideoPreview(second.owner, url)
    expect(restored).toMatchObject({ width: 640, height: 360 })
    expect(restored?.poster).toBeInstanceOf(Blob)
    expect(await restored?.poster?.arrayBuffer()).toEqual(await image.arrayBuffer())
    const bytes = await getPersistedCacheSizeBytes()
    expect(bytes).toBeGreaterThan(image.size)
    expect(bytes).toBeLessThan(image.size + 2048)
    expect(JSON.stringify(await get((await keys(storage.cacheStore)).find(key => isVideoPreviewCacheKey(key))!, storage.cacheStore))).not.toContain("blob:")
  })

  it("isolates URLs and accounts and clears only the retired account", async () => {
    const a = await qualified()
    expect(await saveVideoPreview(a.owner, url, { width: 640, height: 360, poster: poster() })).toBe(true)
    expect(await readVideoPreview(a.owner, url + "-different")).toBeNull()
    const other = `other-${crypto.randomUUID()}`
    const b = await qualified(other)
    expect(await readVideoPreview(a.owner, url)).toBeNull()
    expect(await readVideoPreview(b.owner, url)).toBeNull()
    expect(await saveVideoPreview(b.owner, url, { width: 320, height: 240 })).toBe(true)
    await clearPersistedCache(account)
    expect((await keys(storage.cacheStore)).filter(key => isVideoPreviewCacheKey(key, account))).toHaveLength(0)
    expect(await readVideoPreview(b.owner, url)).toMatchObject({ width: 320, height: 240 })
    expect(await saveVideoPreview(a.owner, url, { width: 100, height: 100 })).toBe(false)
  })

  it("retires one channel's disk rows and rejects its late frame without retiring another channel", async () => {
    const { owner, persister } = await qualified()
    const otherUrl = `/api/community/channels/${crypto.randomUUID()}/attachments/other`
    const other = await captureVideoPreviewOwner(account, otherUrl)
    if (!other) throw new Error("Other channel owner missing")
    await saveVideoPreview(owner, url, { width: 640, height: 360, poster: poster() })
    await saveVideoPreview(other, otherUrl, { width: 200, height: 100 })
    await persister.retireChannels([channel], true)
    expect(await readVideoPreview(owner, url)).toBeNull()
    expect(await saveVideoPreview(owner, url, { width: 640, height: 360, poster: poster() })).toBe(false)
    expect(await captureVideoPreviewOwner(account, url)).toBeNull()
    expect(await readVideoPreview(other, otherUrl)).toMatchObject({ width: 200, height: 100 })
    expect((await keys(storage.cacheStore)).filter(key => isVideoPreviewCacheKey(key, account))).toHaveLength(1)
  })

  it("clears all previews and fences a captured writer across a fresh device owner", async () => {
    const first = await qualified()
    await saveVideoPreview(first.owner, url, { width: 640, height: 360, poster: poster() })
    await clearAllPersistedCaches()
    expect(await saveVideoPreview(first.owner, url, { width: 640, height: 360, poster: poster() })).toBe(false)
    const fresh = await qualified()
    expect(fresh.owner.device).not.toBe(first.owner.device)
    expect(await readVideoPreview(fresh.owner, url)).toBeNull()
    expect((await keys(storage.cacheStore)).filter(key => isVideoPreviewCacheKey(key))).toHaveLength(0)
    expect(await getPersistedCacheSizeBytes()).toBe(0)
  })

  it("rejects corrupt dimensions and oversized or non-JPEG pixels without replacing a good record", async () => {
    const { owner } = await qualified()
    await saveVideoPreview(owner, url, { width: 640, height: 360, poster: poster() })
    expect(await saveVideoPreview(owner, url, { width: -1, height: 100 })).toBe(false)
    expect(await saveVideoPreview(owner, url, { width: 640, height: 360, poster: new Blob([new Uint8Array(MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES + 1)], { type: "image/jpeg" }) })).toBe(false)
    expect(await saveVideoPreview(owner, url, { width: 640, height: 360, poster: new Blob(["bad"], { type: "text/html" }) })).toBe(false)
    expect(await readVideoPreview(owner, url)).toMatchObject({ width: 640, height: 360 })
    const key = (await keys(storage.cacheStore)).find(key => isVideoPreviewCacheKey(key, account))!
    const row = await get<Record<string, unknown>>(key, storage.cacheStore)
    await set(key, { ...row, width: -1 }, storage.cacheStore)
    expect(await readVideoPreview(owner, url)).toBeNull()
    expect(await get(key, storage.cacheStore)).toBeUndefined()
  })

  it("bounds all derived previews and keeps the newest committed entry", async () => {
    const { owner } = await qualified()
    for (let index = 0; index < 35; index++) expect(await saveVideoPreview(owner, `${url}${index}`, { width: 640, height: 360 })).toBe(true)
    expect((await keys(storage.cacheStore)).filter(key => isVideoPreviewCacheKey(key))).toHaveLength(32)
    expect(await readVideoPreview(owner, `${url}34`)).toMatchObject({ width: 640, height: 360 })
  })

  it("falls back when storage is unavailable or the source has no canonical private scope", async () => {
    const { owner } = await qualified()
    expect(await captureVideoPreviewOwner(account, "/public-demo.mp4")).toBeNull()
    expect(await captureVideoPreviewOwner("different-account", url)).toBeNull()
    vi.spyOn(storage, "cacheTransaction").mockRejectedValue(new DOMException("Storage blocked", "SecurityError"))
    expect(await captureVideoPreviewOwner(account, url)).toBeNull()
    expect(await readVideoPreview(owner, url)).toBeNull()
    expect(await saveVideoPreview(owner, url, { width: 640, height: 360 })).toBe(false)
  })
})
