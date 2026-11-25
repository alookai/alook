import "fake-indexeddb/auto"
import { QueryClient } from "@tanstack/react-query"
import { set } from "idb-keyval"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { channelFenceKey } from "@/lib/persisted-account-identity"
import * as storage from "@/lib/query-cache-store"
import {
  clearHtmlPreviewHeightChannels,
  invalidateHtmlPreviewHeightMemoryCache,
  isHtmlPreviewHeightCacheKey,
  readHtmlPreviewHeight,
  readHtmlPreviewMemoryHeight,
  saveHtmlPreviewHeight,
  warmHtmlPreviewMemoryHeights,
  writeHtmlPreviewMemoryHeight,
} from "./html-preview-height-cache"

afterEach(async () => {
  vi.restoreAllMocks()
  await clearAllPersistedCaches()
})

describe("html-preview-height-cache", () => {
  it("persists clamped heights in IndexedDB and invalidates memory cache on clear", async () => {
    const client = new QueryClient()
    expect(writeHtmlPreviewMemoryHeight(client, "att-1", 512.3)).toBe(513)
    expect(readHtmlPreviewMemoryHeight(client, "att-1")).toBe(513)

    const url = "/api/community/channels/ch-1/attachments/att-1"
    const saved = await saveHtmlPreviewHeight("viewer", "att-1", url, 512.3)
    expect(saved).toBe(true)
    expect(await readHtmlPreviewHeight("viewer", "att-1", url)).toBe(513)
    expect(await readHtmlPreviewHeight("other", "att-1", url)).toBeNull()

    await storage.cacheTransaction("readwrite", (store) => clearHtmlPreviewHeightChannels(store, "viewer", ["ch-1"]))
    expect(readHtmlPreviewMemoryHeight(client, "att-1")).toBeUndefined()
    expect(await readHtmlPreviewHeight("viewer", "att-1", url)).toBeNull()
    expect(isHtmlPreviewHeightCacheKey("alook:html-preview-height:v1:viewer:ch-1:att-1", "viewer")).toBe(true)
    expect(isHtmlPreviewHeightCacheKey("alook:html-preview-height:v1:viewer:ch-1:att-1", "other")).toBe(false)
  })

  it("warms only the target account prefix, skips fenced/corrupt entries, and preserves LRU order", async () => {
    const now = vi.spyOn(Date, "now")
    now.mockReturnValue(1_000)
    expect(await saveHtmlPreviewHeight("viewer", "att-old", "/api/community/channels/ch-ok/attachments/att-old", 140)).toBe(true)
    now.mockReturnValue(3_000)
    expect(await saveHtmlPreviewHeight("viewer", "att-new", "/api/community/channels/ch-ok/attachments/att-new", 480)).toBe(true)
    now.mockReturnValue(2_000)
    expect(await saveHtmlPreviewHeight("viewer", "att-mid", "/api/community/channels/ch-ok/attachments/att-mid", 260)).toBe(true)
    expect(await saveHtmlPreviewHeight("viewer", "att-deleted", "/api/community/channels/ch-deleted/attachments/att-deleted", 300)).toBe(true)
    expect(await saveHtmlPreviewHeight("viewer", "att-retired", "/api/community/channels/ch-retired/attachments/att-retired", 350)).toBe(true)
    expect(await saveHtmlPreviewHeight("viewer-2", "att-prefix-neighbor", "/api/community/channels/ch-ok/attachments/att-prefix-neighbor", 600)).toBe(true)
    expect(await saveHtmlPreviewHeight("other", "att-other", "/api/community/channels/ch-ok/attachments/att-other", 700)).toBe(true)

    await set(
      channelFenceKey("viewer"),
      new Map([
        ["ch-deleted", { epoch: crypto.randomUUID(), deleted: true }],
        ["ch-retired", { epoch: crypto.randomUUID(), deleted: false }],
      ]),
      storage.cacheStore,
    )
    await set("alook:html-preview-height:v1:viewer:ch-ok:att-bad-version", { version: 2, height: 200, channelId: "ch-ok", savedAt: 4_000 }, storage.cacheStore)
    await set("alook:html-preview-height:v1:viewer:ch-ok:att-bad-height", { version: 1, height: 50, channelId: "ch-ok", savedAt: 4_000 }, storage.cacheStore)
    await set("alook:html-preview-height:v1:viewer:ch-ok:att-bad-channel", { version: 1, height: 220, channelId: "ch-mismatch", savedAt: 4_000 }, storage.cacheStore)

    invalidateHtmlPreviewHeightMemoryCache()
    const fresh = new QueryClient()
    const warmed = await warmHtmlPreviewMemoryHeights(fresh, "viewer")
    expect(warmed).toBe(3)
    expect(readHtmlPreviewMemoryHeight(fresh, "att-old")).toBe(140)
    expect(readHtmlPreviewMemoryHeight(fresh, "att-mid")).toBe(260)
    expect(readHtmlPreviewMemoryHeight(fresh, "att-new")).toBe(480)
    expect(readHtmlPreviewMemoryHeight(fresh, "att-deleted")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-retired")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-prefix-neighbor")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-other")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-bad-version")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-bad-height")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(fresh, "att-bad-channel")).toBeUndefined()

    const lruClient = new QueryClient()
    expect(await warmHtmlPreviewMemoryHeights(lruClient, "viewer")).toBe(3)
    for (let index = 0; index < 254; index++) {
      writeHtmlPreviewMemoryHeight(lruClient, `fill-${index}`, 120)
    }
    expect(readHtmlPreviewMemoryHeight(lruClient, "att-old")).toBeUndefined()
    expect(readHtmlPreviewMemoryHeight(lruClient, "att-mid")).toBe(260)
    expect(readHtmlPreviewMemoryHeight(lruClient, "att-new")).toBe(480)
  })

  it("fails closed on corrupt fences, retired lifecycle, or storage failure", async () => {
    expect(await saveHtmlPreviewHeight("viewer", "att-1", "/api/community/channels/ch-1/attachments/att-1", 420)).toBe(true)

    const retiredClient = new QueryClient()
    expect(await warmHtmlPreviewMemoryHeights(retiredClient, "viewer", { isCurrent: () => false })).toBe(0)
    expect(readHtmlPreviewMemoryHeight(retiredClient, "att-1")).toBeUndefined()

    await set(channelFenceKey("viewer"), "corrupt-fence", storage.cacheStore)
    const corruptFenceClient = new QueryClient()
    expect(await warmHtmlPreviewMemoryHeights(corruptFenceClient, "viewer")).toBe(0)
    expect(readHtmlPreviewMemoryHeight(corruptFenceClient, "att-1")).toBeUndefined()

    vi.spyOn(storage, "cacheTransaction").mockRejectedValue(new DOMException("Blocked", "SecurityError"))
    const errorClient = new QueryClient()
    expect(await warmHtmlPreviewMemoryHeights(errorClient, "viewer")).toBe(0)
    expect(readHtmlPreviewMemoryHeight(errorClient, "att-1")).toBeUndefined()
  })
})
