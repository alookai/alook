import React, { useLayoutEffect, useRef } from "react"
import "fake-indexeddb/auto"
import { Blob as NativeBlob } from "node:buffer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, useIsRestoring, useQueryClient } from "@tanstack/react-query"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { clearAllPersistedCaches, createIdbPersister } from "@/lib/query-persister"
import {
  invalidateHtmlPreviewHeightMemoryCache,
  readHtmlPreviewMemoryHeight,
  saveHtmlPreviewHeight,
} from "@/lib/community/html-preview-height-cache"
import * as htmlPreviewCache from "@/lib/community/html-preview-height-cache"
import {
  captureVideoPreviewOwner,
  invalidateVideoMemoryDimensionsCache,
  readVideoMemoryDimensions,
  saveVideoPreview,
} from "@/lib/community/video-preview-cache"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { HtmlAttachmentPreview } from "@/components/community/messages/html-attachment-preview"
import { VideoAttachmentBlock } from "@/components/community/messages/video-attachment-block"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "@/lib/community/models/message"

const session = vi.hoisted(() => ({ viewer: "account-a" as string | null }))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: session.viewer ? { user: { id: session.viewer, email: `${session.viewer}@example.test` } } : null,
    isPending: false,
    error: null,
  }),
  currentSessionViewer: () => session.viewer,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))

import { QueryProvider } from "./QueryProvider"

const originalInnerHeight = window.innerHeight
const popoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "popover")
const audioTracksDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "audioTracks")

function jpegPoster() {
  return new NativeBlob([new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4])], { type: "image/jpeg" }) as unknown as Blob
}

beforeEach(async () => {
  session.viewer = "account-a"
  vi.stubGlobal("Blob", NativeBlob)
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1200 })
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
  invalidateHtmlPreviewHeightMemoryCache()
  invalidateVideoMemoryDimensionsCache()
  await clearAllPersistedCaches()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight })
  if (popoverDescriptor) Object.defineProperty(HTMLElement.prototype, "popover", popoverDescriptor)
  if (audioTracksDescriptor) Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", audioTracksDescriptor)
  invalidateHtmlPreviewHeightMemoryCache()
  invalidateVideoMemoryDimensionsCache()
  await clearAllPersistedCaches()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe("QueryProvider cold-start preview cache warmup", () => {
  it("renders HtmlAttachmentPreview and VideoAttachmentBlock with real cached dimensions on first paint without per-card HTML IDB reads", async () => {
    const createObjectUrl = vi.fn(() => "blob:warmed-video-poster")
    const revokeObjectUrl = vi.fn()
    const OriginalURL = URL
    vi.stubGlobal("URL", class extends OriginalURL {
      static createObjectURL = createObjectUrl
      static revokeObjectURL = revokeObjectUrl
    })

    const htmlAttachment: FileAttachment & { id: string } = {
      id: "html-1",
      kind: "file",
      name: "chart.html",
      url: "/api/community/channels/ch-1/attachments/html-1",
      contentType: "text/html",
      size: "2 KB",
    }
    const landscapeVideo: FileAttachment = {
      kind: "file",
      name: "wide.mp4",
      url: "/api/community/channels/ch-1/attachments/video-wide",
      contentType: "video/mp4",
      size: "4 KB",
      sizeBytes: 4096,
    }
    const portraitVideo: FileAttachment = {
      kind: "file",
      name: "tall.mp4",
      url: "/api/community/channels/ch-1/attachments/video-tall",
      contentType: "video/mp4",
      size: "4 KB",
      sizeBytes: 4096,
    }

    const otherPersister = createIdbPersister("account-b")
    expect(await otherPersister.isCurrent()).toBe(true)
    await otherPersister.rememberAccountIdentity({ id: "account-b", email: "account-b@example.test" }, () => {})
    expect(await saveHtmlPreviewHeight("account-b", "html-other", "/api/community/channels/ch-9/attachments/html-other", 620)).toBe(true)
    otherPersister.stopPersisting()

    const persister = createIdbPersister("account-a")
    expect(await persister.isCurrent()).toBe(true)
    await persister.rememberAccountIdentity({ id: "account-a", email: "account-a@example.test" }, () => {})
    expect(await saveHtmlPreviewHeight("account-a", htmlAttachment.id, htmlAttachment.url, 480)).toBe(true)
    const wideOwner = await captureVideoPreviewOwner("account-a", landscapeVideo.url)
    const tallOwner = await captureVideoPreviewOwner("account-a", portraitVideo.url)
    expect(wideOwner).not.toBeNull()
    expect(tallOwner).not.toBeNull()
    expect(await saveVideoPreview(wideOwner!, landscapeVideo.url, { width: 1280, height: 720, poster: jpegPoster() })).toBe(true)
    expect(await saveVideoPreview(tallOwner!, portraitVideo.url, { width: 720, height: 1280, poster: jpegPoster() })).toBe(true)
    persister.stopPersisting()

    invalidateHtmlPreviewHeightMemoryCache()
    invalidateVideoMemoryDimensionsCache()
    const readHtmlSpy = vi.spyOn(htmlPreviewCache, "readHtmlPreviewHeight")

    const observedFirstPaint = {
      htmlHeights: [] as string[],
      wideRatios: [] as string[],
      tallRatios: [] as string[],
      objectUrlCallsBeforeMount: -1,
    }
    let mountedClient: QueryClient | null = null
    let mountedRegistry: CommunityDbRegistry | null = null

    function RestoredContent() {
      const htmlWrap = useRef<HTMLDivElement>(null)
      const wideWrap = useRef<HTMLDivElement>(null)
      const tallWrap = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => {
        const frame = htmlWrap.current?.querySelector<HTMLIFrameElement>(`[data-testid="${tid.htmlPreviewFrame(htmlAttachment.id)}"]`)
        const wideCard = wideWrap.current?.querySelector<HTMLElement>(`[data-testid="${tid.mediaBlock(landscapeVideo.name)}"]`)
        const tallCard = tallWrap.current?.querySelector<HTMLElement>(`[data-testid="${tid.mediaBlock(portraitVideo.name)}"]`)
        if (frame) observedFirstPaint.htmlHeights.push(frame.style.height)
        if (wideCard) observedFirstPaint.wideRatios.push(wideCard.style.aspectRatio)
        if (tallCard) observedFirstPaint.tallRatios.push(tallCard.style.aspectRatio)
      })
      return (
        <div>
          <div ref={htmlWrap}><HtmlAttachmentPreview attachment={htmlAttachment} /></div>
          <div ref={wideWrap}><VideoAttachmentBlock attachment={landscapeVideo} /></div>
          <div ref={tallWrap}><VideoAttachmentBlock attachment={portraitVideo} /></div>
        </div>
      )
    }

    function GateProbe() {
      const restoring = useIsRestoring()
      mountedClient = useQueryClient()
      mountedRegistry = useOptionalCommunityDbRegistry()
      if (!restoring && observedFirstPaint.objectUrlCallsBeforeMount === -1) {
        observedFirstPaint.objectUrlCallsBeforeMount = createObjectUrl.mock.calls.length
      }
      return restoring ? <div data-testid="restoring">restoring</div> : <RestoredContent />
    }

    const view = render(
      <QueryProvider userId="account-a">
        <GateProbe />
      </QueryProvider>,
    )
    try {
      await waitFor(() => expect(view.queryByTestId("restoring")).toBeNull())
      expect(observedFirstPaint.objectUrlCallsBeforeMount).toBe(0)
      expect(observedFirstPaint.htmlHeights[0]).toBe("480px")
      expect(observedFirstPaint.htmlHeights).not.toContain("320px")
      expect(observedFirstPaint.wideRatios[0]).toBe("1280/720")
      expect(observedFirstPaint.wideRatios).not.toContain("4/3")
      expect(observedFirstPaint.tallRatios[0]).toBe("720/1280")
      expect(observedFirstPaint.tallRatios).not.toContain("4/3")
      expect(readHtmlSpy).not.toHaveBeenCalled()
      expect(readHtmlPreviewMemoryHeight(mountedClient!, "html-other")).toBeUndefined()
      expect(readVideoMemoryDimensions(mountedRegistry, landscapeVideo.url)).toEqual({ width: 1280, height: 720 })
      expect(readVideoMemoryDimensions(mountedRegistry, portraitVideo.url)).toEqual({ width: 720, height: 1280 })
      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2))
    } finally {
      act(() => view.unmount())
    }
  })

  it("does not pollute retired or switched account instances when an in-flight warmup settles late", async () => {
    const persisterA = createIdbPersister("account-a")
    expect(await persisterA.isCurrent()).toBe(true)
    await persisterA.rememberAccountIdentity({ id: "account-a", email: "account-a@example.test" }, () => {})
    const htmlUrlA = "/api/community/channels/ch-a/attachments/html-a"
    const videoUrlA = "/api/community/channels/ch-a/attachments/video-a"
    expect(await saveHtmlPreviewHeight("account-a", "html-a", htmlUrlA, 510)).toBe(true)
    const ownerA = await captureVideoPreviewOwner("account-a", videoUrlA)
    expect(await saveVideoPreview(ownerA!, videoUrlA, { width: 1920, height: 1080 })).toBe(true)
    persisterA.stopPersisting()

    invalidateHtmlPreviewHeightMemoryCache()
    invalidateVideoMemoryDimensionsCache()

    let releaseWarmup!: () => void
    let warmupStarted!: () => void
    const warmupStartedPromise = new Promise<void>((resolve) => { warmupStarted = resolve })
    const warmupGate = new Promise<void>((resolve) => { releaseWarmup = resolve })
    const originalWarmHtml = htmlPreviewCache.warmHtmlPreviewMemoryHeights
    let heldOnce = false
    vi.spyOn(htmlPreviewCache, "warmHtmlPreviewMemoryHeights").mockImplementation(async (client, accountId, options) => {
      if (!heldOnce && accountId === "account-a") {
        heldOnce = true
        warmupStarted()
        await warmupGate
        return originalWarmHtml(client, accountId, { isCurrent: options?.isCurrent })
      }
      return originalWarmHtml(client, accountId, options)
    })

    const clients: Record<string, QueryClient> = {}
    const registries: Record<string, CommunityDbRegistry> = {}
    let restoringB = true
    function Probe({ account }: { account: string }) {
      const client = useQueryClient()
      const registry = useOptionalCommunityDbRegistry()!
      const restoring = useIsRestoring()
      useLayoutEffect(() => {
        clients[account] = client
        registries[account] = registry
        if (account === "account-b") restoringB = restoring
      })
      return null
    }

    const view = render(
      <QueryProvider userId="account-a">
        <Probe account="account-a" />
      </QueryProvider>,
    )
    try {
      await warmupStartedPromise
      session.viewer = "account-b"
      view.rerender(
        <QueryProvider userId="account-b">
          <Probe account="account-b" />
        </QueryProvider>,
      )
      await waitFor(() => expect(restoringB).toBe(false))
      await act(async () => {
        releaseWarmup()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(readHtmlPreviewMemoryHeight(clients["account-a"]!, "html-a")).toBeUndefined()
      expect(readHtmlPreviewMemoryHeight(clients["account-b"]!, "html-a")).toBeUndefined()
      expect(readVideoMemoryDimensions(registries["account-b"], videoUrlA)).toBeNull()
    } finally {
      act(() => view.unmount())
    }
  })

  it("releases restoreGate and boots cleanly when preview cache warmup fails", async () => {
    const originalWarmHtml = htmlPreviewCache.warmHtmlPreviewMemoryHeights
    vi.spyOn(htmlPreviewCache, "warmHtmlPreviewMemoryHeights").mockImplementation((client, accountId, options) => {
      if (options?.store) return Promise.reject(new DOMException("IDB unavailable", "InvalidStateError"))
      return originalWarmHtml(client, accountId, options)
    })
    let restoring = true
    let registry: CommunityDbRegistry | null = null
    function Probe() {
      restoring = useIsRestoring()
      registry = useOptionalCommunityDbRegistry()
      return <div data-testid="boot-state">{restoring ? "restoring" : "ready"}</div>
    }

    const view = render(
      <QueryProvider userId="account-a">
        <Probe />
      </QueryProvider>,
    )
    try {
      await waitFor(() => expect(view.getByTestId("boot-state").textContent).toBe("ready"))
      expect(restoring).toBe(false)
      await expect(registry!.ready).resolves.toBeUndefined()
    } finally {
      act(() => view.unmount())
    }
  })
})
