import "fake-indexeddb/auto"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import {
  clearHtmlPreviewHeightChannels,
  isHtmlPreviewHeightCacheKey,
  readHtmlPreviewHeight,
  readHtmlPreviewMemoryHeight,
  saveHtmlPreviewHeight,
  writeHtmlPreviewMemoryHeight,
} from "./html-preview-height-cache"
import { cacheTransaction } from "@/lib/query-cache-store"

afterEach(async () => {
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

    await cacheTransaction("readwrite", (store) => clearHtmlPreviewHeightChannels(store, "viewer", ["ch-1"]))
    expect(readHtmlPreviewMemoryHeight(client, "att-1")).toBeUndefined()
    expect(await readHtmlPreviewHeight("viewer", "att-1", url)).toBeNull()
    expect(isHtmlPreviewHeightCacheKey("alook:html-preview-height:v1:viewer:ch-1:att-1", "viewer")).toBe(true)
    expect(isHtmlPreviewHeightCacheKey("alook:html-preview-height:v1:viewer:ch-1:att-1", "other")).toBe(false)
  })
})
