import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import {
  capturePreparedShareImage,
  prepareShareImageSession,
} from "./share-image-session"

const FONT_CSS = "@font-face{font-family:Brand;src:url(data:font/woff2;base64,AA==)}"

class DecodableImage {
  onload: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  naturalWidth = 2
  naturalHeight = 2
  decode = vi.fn().mockResolvedValue(undefined)

  set src(_value: string) {
    queueMicrotask(() => this.onload?.(new Event("load")))
  }
}

function sourceCard(markup: string): HTMLElement {
  const wrapper = document.createElement("div")
  wrapper.innerHTML = `
    <div data-share-card-source style="width:320px;background-color:rgb(255,255,255);--card:rgb(255,255,255)">
      ${markup}
      <span data-share-brand style="font-family:Brand;font-weight:700">Alook</span>
    </div>
  `
  const source = wrapper.firstElementChild as HTMLElement
  document.body.appendChild(source)
  return source
}

function imageResponse(
  bytes = new Uint8Array([1, 2, 3]),
  contentType = "image/png",
): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
  })
}

function dataUrlResponse(bytes: Uint8Array) {
  return {
    ok: true,
    blob: vi.fn().mockResolvedValue(new Blob([bytes], { type: "image/png" })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function prepare(
  source: HTMLElement,
  fetchAsset: typeof fetch = vi.fn(),
  maxSessionAssetBytes?: number,
) {
  return prepareShareImageSession(source, {
    fetchAsset,
    getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
    maxSessionAssetBytes,
    staticizeAsset: async (blob) => blob,
    waitForPaint: vi.fn().mockResolvedValue(undefined),
  })
}

beforeEach(() => {
  vi.stubGlobal("Image", DecodableImage)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 180))
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load: vi.fn().mockResolvedValue([{} as FontFace]),
      ready: Promise.resolve(),
      check: vi.fn(() => true),
    },
  })
})

afterEach(() => {
  document.body.replaceChildren()
  delete (document as Document & { fonts?: FontFaceSet }).fonts
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("prepareShareImageSession", () => {
  it("resolves same-origin images to immutable bytes without mutating the React source", async () => {
    const source = sourceCard('<img src="/content.png" alt="content">')
    const fetchAsset = vi.fn().mockResolvedValue(imageResponse())

    const prepared = await prepare(source, fetchAsset)

    expect(fetchAsset).toHaveBeenCalledTimes(1)
    expect(fetchAsset.mock.calls[0]![0]).toMatch(/\/content\.png$/)
    expect(fetchAsset.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
    })
    expect(prepared.markup).toContain("data-share-card=\"\"")
    expect(prepared.markup).not.toContain("data-share-card-source")
    expect(prepared.markup).toContain("data:image/png;base64,AQID")
    expect(prepared.markup).toContain("data-share-byte-backed=\"true\"")
    expect(prepared.markup).toContain("animation: none !important")
    expect(prepared.fontEmbedCSS).toBe(FONT_CSS)
    expect(source.querySelector("img")?.getAttribute("src")).toBe("/content.png")
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
    expect(Object.isFrozen(prepared)).toBe(true)
  })

  it("normalizes an external visible avatar through the scoped same-origin route", async () => {
    const source = sourceCard(`
      <div data-share-identity-id="user 1">
        <img data-avatar-photo-state="ready" src="https://avatars.githubusercontent.com/u/1?v=4">
      </div>
    `)
    const fetchAsset = vi.fn().mockResolvedValue(imageResponse())

    const prepared = await prepare(source, fetchAsset)

    expect(fetchAsset).toHaveBeenCalledWith(
      "/api/community/share-image/avatar/user%201",
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
    )
    expect(prepared.markup).not.toContain("avatars.githubusercontent.com")
    expect(prepared.markup).toContain("data:image/png;base64,AQID")
  })

  it("encodes the format-defined default frame as a static PNG before ready", async () => {
    const bitmap = { width: 8, height: 8, close: vi.fn() }
    const createBitmap = vi.fn().mockResolvedValue(bitmap)
    const drawImage = vi.fn()
    vi.stubGlobal("createImageBitmap", createBitmap)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      drawImage,
    }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([9])], { type: "image/png" }))
    })
    const source = sourceCard('<img src="/animated.gif" alt="animated">')
    const fetchAsset = vi.fn().mockResolvedValue(imageResponse(
      new Uint8Array([71, 73, 70]),
      "image/gif",
    ))

    const prepared = await prepareShareImageSession(source, {
      fetchAsset,
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })

    expect(createBitmap).toHaveBeenCalledTimes(1)
    expect(createBitmap.mock.calls[0]![0]).toMatchObject({ type: "image/gif", size: 3 })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 8, 8)
    expect(prepared.markup).toContain("data:image/png;base64,CQ==")
    expect(prepared.markup).not.toContain("data:image/gif")
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it("uses the largest occurrence target for a repeated asset regardless of DOM order", async () => {
    const run = async (order: readonly ["small", "large"] | readonly ["large", "small"]) => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function () {
        if (!(this instanceof HTMLImageElement)) return new DOMRect(0, 0, 320, 180)
        return this.dataset.size === "large"
          ? new DOMRect(0, 0, 80, 40)
          : new DOMRect(0, 0, 20, 10)
      })
      const source = sourceCard(order.map((size) => (
        `<img data-size="${size}" src="/same.png">`
      )).join(""))
      const targets: Array<{ width: number; height: number }> = []
      const staticizeAsset = vi.fn(async (_blob: Blob, target: { width: number; height: number }) => {
        targets.push(target)
        return new Blob([JSON.stringify(target)], { type: "image/png" })
      })
      const fetchAsset = vi.fn(() => Promise.resolve(imageResponse()))
      const prepared = await prepareShareImageSession(source, {
        fetchAsset,
        getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
        staticizeAsset,
        waitForPaint: vi.fn().mockResolvedValue(undefined),
      })
      const parsed = document.createElement("div")
      parsed.innerHTML = prepared.markup
      const card = parsed.firstElementChild as HTMLElement
      document.body.appendChild(card)
      const sources = [...card.querySelectorAll<HTMLImageElement>("img")]
        .map((image) => image.src)
      const exported = await capturePreparedShareImage(card, FONT_CSS, async (capture) => {
        const captureSources = [...capture.querySelectorAll<HTMLImageElement>("img")]
          .map((image) => image.src)
        expect(captureSources).toEqual(sources)
        return new Blob([sources[0]!], { type: "image/png" })
      })
      card.remove()
      source.remove()
      return {
        exportBytes: [...new Uint8Array(await exported.arrayBuffer())],
        fetchAsset,
        sources,
        staticizeAsset,
        targets,
      }
    }

    const smallFirst = await run(["small", "large"])
    const largeFirst = await run(["large", "small"])

    for (const result of [smallFirst, largeFirst]) {
      expect(result.fetchAsset).toHaveBeenCalledTimes(1)
      expect(result.staticizeAsset).toHaveBeenCalledTimes(1)
      expect(result.targets).toEqual([{ width: 160, height: 80 }])
      expect(new Set(result.sources).size).toBe(1)
    }
    expect(smallFirst.sources[0]).toBe(largeFirst.sources[0])
    expect(smallFirst.exportBytes).toEqual(largeFirst.exportBytes)
  })

  it("keeps unsupported decode semantics split between content and identity", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("codec unavailable")))
    const fetchAsset = vi.fn(() => Promise.resolve(imageResponse()))
    const content = sourceCard('<img src="/content.webp">')

    await expect(prepareShareImageSession(content, {
      fetchAsset,
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "assets" })

    content.remove()
    const identity = sourceCard(`
      <div data-share-identity-id="u1">
        <img data-avatar-photo-state="ready" src="/avatar.webp">
      </div>
    `)
    const prepared = await prepareShareImageSession(identity, {
      fetchAsset,
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })
    expect(prepared.markup).toContain("data-share-identity-fallback=\"beam\"")
    expect(prepared.markup).not.toContain("<img")
  })

  it("treats decoded dimension overflow as a hard budget error for identities", async () => {
    const bitmap = { width: 8_193, height: 1, close: vi.fn() }
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap))
    const source = sourceCard(`
      <div data-share-identity-id="u1">
        <img data-avatar-photo-state="ready" src="/avatar.png">
      </div>
    `)

    await expect(prepareShareImageSession(source, {
      fetchAsset: vi.fn().mockResolvedValue(imageResponse()),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(source.querySelector("[data-share-identity-fallback]")).toBeNull()
  })

  it("caps summed decoded pixels across unique session assets", async () => {
    const bitmaps = [
      { width: 4_096, height: 2_048, close: vi.fn() },
      { width: 4_096, height: 2_049, close: vi.fn() },
    ]
    vi.stubGlobal("createImageBitmap", vi.fn()
      .mockResolvedValueOnce(bitmaps[0])
      .mockResolvedValueOnce(bitmaps[1]))
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      drawImage: vi.fn(),
    }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([9])], { type: "image/png" }))
    })
    const source = sourceCard('<img src="/one.png"><img src="/two.png">')

    await expect(prepareShareImageSession(source, {
      fetchAsset: vi.fn(() => Promise.resolve(imageResponse())),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(bitmaps[1].close).toHaveBeenCalledTimes(1)
    expect(source.querySelector("[data-share-byte-backed]")).toBeNull()
  })

  it("treats oversized static PNG output as a hard budget error for identities", async () => {
    const source = sourceCard(`
      <div data-share-identity-id="u1">
        <img data-avatar-photo-state="ready" src="/avatar.png">
      </div>
    `)
    const oversizedPng = {
      type: "image/png",
      size: 10 * 1024 * 1024 + 1,
    } as Blob

    await expect(prepareShareImageSession(source, {
      fetchAsset: vi.fn().mockResolvedValue(imageResponse()),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      staticizeAsset: vi.fn().mockResolvedValue(oversizedPng),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })
    expect(source.querySelector("[data-share-identity-fallback]")).toBeNull()
  })

  it("fetches external content without credentials and fails the session atomically on error", async () => {
    const source = sourceCard('<img src="https://cdn.example/photo.png" alt="content">')
    const fetchAsset = vi.fn().mockRejectedValue(new Error("CORS denied"))

    await expect(prepare(source, fetchAsset)).rejects.toMatchObject({ stage: "assets" })
    expect(fetchAsset).toHaveBeenCalledWith(
      "https://cdn.example/photo.png",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    )
    expect(source.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/photo.png")
    expect(source.querySelector("[data-share-identity-fallback]")).toBeNull()
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("seeds nested avatar fallbacks by stable identity instead of the changing photo URL", async () => {
    const markup = (url: string) => `
      <div data-share-identity-id="u1" aria-label="Alice">
        <span data-avatar-kind="photo">
          <img data-avatar-photo-state="error" src="${url}">
        </span>
      </div>
    `
    const fetchAsset = vi.fn().mockRejectedValue(new Error("offline"))
    const first = sourceCard(markup("https://avatars.githubusercontent.com/u/1?v=old"))
    const firstPrepared = await prepare(first, fetchAsset)
    first.remove()
    const second = sourceCard(markup("https://avatars.githubusercontent.com/u/1?v=new"))
    const secondPrepared = await prepare(second, fetchAsset)

    expect(firstPrepared.markup).toBe(secondPrepared.markup)
    expect(firstPrepared.markup).toContain("data-share-identity-fallback=\"beam\"")
    expect(firstPrepared.markup).not.toContain("<img")
    expect(first.querySelector("img")).not.toBeNull()
  })

  it("counts a repeated asset once against the session byte budget", async () => {
    const fetchAsset = vi.fn().mockResolvedValue(imageResponse())
    const source = sourceCard('<img src="/warm.png"><img src="/warm.png">')

    const prepared = await prepare(source, fetchAsset, 3)

    expect(fetchAsset).toHaveBeenCalledTimes(1)
    expect(prepared.markup.match(/data:image\/png;base64,AQID/g)).toHaveLength(2)
  })

  it("accepts unique assets totaling exactly the aggregate session byte budget", async () => {
    const source = sourceCard('<img src="/one.png"><img src="/two.png">')
    const fetchAsset = vi.fn((input: string | URL | Request) => Promise.resolve(
      imageResponse(String(input).endsWith("one.png")
        ? new Uint8Array([1, 2])
        : new Uint8Array([3, 4, 5])),
    ))

    const prepared = await prepare(source, fetchAsset, 5)

    expect(fetchAsset).toHaveBeenCalledTimes(2)
    expect(prepared.markup).toContain("data:image/png;base64,AQI=")
    expect(prepared.markup).toContain("data:image/png;base64,AwQF")
  })

  it("fails atomically when unique assets exceed the aggregate session byte budget", async () => {
    const source = sourceCard('<img src="/one.png"><img src="/two.png">')
    const fetchAsset = vi.fn(() => Promise.resolve(imageResponse()))

    await expect(prepare(source, fetchAsset, 5)).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })

    expect(fetchAsset).toHaveBeenCalledTimes(2)
    expect(source.querySelectorAll('img[src$=".png"]')).toHaveLength(2)
    expect(source.querySelector("[data-share-byte-backed]")).toBeNull()
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("does not downgrade an aggregate byte overflow to an avatar fallback", async () => {
    const source = sourceCard(`
      <div data-share-identity-id="u1">
        <img data-avatar-photo-state="ready" src="https://avatars.githubusercontent.com/u/1?v=4">
      </div>
    `)
    const fetchAsset = vi.fn(() => Promise.resolve(
      imageResponse(new Uint8Array([1, 2, 3, 4, 5, 6])),
    ))

    await expect(prepare(source, fetchAsset, 5)).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })

    expect(source.querySelector("img")).not.toBeNull()
    expect(source.querySelector("[data-share-identity-fallback]")).toBeNull()
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("starts a fresh aggregate byte budget when preparation is retried", async () => {
    const source = sourceCard('<img src="/one.png"><img src="/two.png">')
    const firstFetch = vi.fn(() => Promise.resolve(imageResponse()))

    await expect(prepare(source, firstFetch, 5)).rejects.toMatchObject({ stage: "assets" })

    const retryFetch = vi.fn(() => Promise.resolve(imageResponse(new Uint8Array([1, 2]))))
    const prepared = await prepare(source, retryFetch, 5)

    expect(retryFetch).toHaveBeenCalledTimes(2)
    expect(prepared.markup.match(/data:image\/png;base64,AQI=/g)).toHaveLength(2)
    expect(source.querySelector("[data-share-byte-backed]")).toBeNull()
  })

  it.each([
    ["first then second", ["one", "two"]],
    ["second then first", ["two", "one"]],
  ] as const)("fails over-budget concurrent assets when they finish %s", async (_label, order) => {
    const source = sourceCard('<img src="/one.png"><img src="/two.png">')
    const responses = {
      one: deferred<Response>(),
      two: deferred<Response>(),
    }
    const fetchAsset = vi.fn((input: string | URL | Request) => (
      String(input).endsWith("one.png") ? responses.one.promise : responses.two.promise
    ))
    const preparation = prepare(source, fetchAsset, 5)
    const assertion = expect(preparation).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })
    await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(2))

    for (const key of order) {
      responses[key].resolve(imageResponse())
      await Promise.resolve()
    }

    await assertion
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("cancels remaining response reads when the aggregate byte budget is exceeded", async () => {
    const source = sourceCard('<img src="/overflow.png"><img src="/blocked.png">')
    const overflow = deferred<Response>()
    const blockedPull = vi.fn(() => new Promise<void>(() => {}))
    const blockedCancel = vi.fn()
    const blockedResponse = new Response(new ReadableStream<Uint8Array>({
      pull: blockedPull,
      cancel: blockedCancel,
    }), { headers: { "Content-Type": "image/png" } })
    const fetchAsset = vi.fn((input: string | URL | Request) => (
      String(input).endsWith("overflow.png") ? overflow.promise : Promise.resolve(blockedResponse)
    ))
    const preparation = prepare(source, fetchAsset, 5)
    const assertion = expect(preparation).rejects.toMatchObject({
      stage: "assets",
      cause: { name: "ShareImageSessionBudgetError" },
    })
    await vi.waitFor(() => expect(blockedPull).toHaveBeenCalled())

    overflow.resolve(imageResponse(new Uint8Array([1, 2, 3, 4, 5, 6])))

    await assertion
    await vi.waitFor(() => expect(blockedCancel).toHaveBeenCalled())
  })

  it("times out a non-cooperative asset request", async () => {
    vi.useFakeTimers()
    const source = sourceCard('<img src="/pending.png">')
    const fetchAsset = vi.fn(() => new Promise<Response>(() => {}))
    const pending = prepareShareImageSession(source, {
      fetchAsset,
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 25,
    })
    const assertion = expect(pending).rejects.toMatchObject({ stage: "assets", timedOut: true })

    await act(async () => vi.advanceTimersByTimeAsync(25))

    await assertion
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("treats an empty font embed as a hard preparation failure", async () => {
    const source = sourceCard("<span>hello</span>")

    await expect(prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(""),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "fonts", timedOut: false })
  })

  it("times out while waiting for unresolved source placeholders", async () => {
    vi.useFakeTimers()
    const source = sourceCard('<span data-slot="skeleton">loading</span>')
    const pending = prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 25,
    })
    const assertion = expect(pending).rejects.toMatchObject({ stage: "source", timedOut: true })

    await act(async () => vi.advanceTimersByTimeAsync(25))

    await assertion
  })

  it("uses requestAnimationFrame for default paint waits", async () => {
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(1)
      return 1
    })
    vi.stubGlobal("requestAnimationFrame", requestFrame)
    const source = sourceCard("<span>ready</span>")

    const prepared = await prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
    })

    expect(prepared.markup).toContain("ready")
    expect(requestFrame).toHaveBeenCalledTimes(4)
  })

  it("falls back to resolved paint waits when requestAnimationFrame is unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined)
    const source = sourceCard("<span>ready</span>")

    const prepared = await prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
    })

    expect(prepared.markup).toContain("ready")
  })

  it("waits through irrelevant source mutations until the skeleton is removed", async () => {
    const source = sourceCard('<span data-slot="skeleton">loading</span>')
    const pending = prepare(source)

    source.appendChild(document.createElement("span"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    source.querySelector('[data-slot="skeleton"]')!.remove()

    await expect(pending).resolves.toMatchObject({ fontEmbedCSS: FONT_CSS })
  })

  it("handles a source skeleton disappearing during observer setup", async () => {
    const disconnect = vi.fn()
    class RaceMutationObserver {
      constructor(_callback: MutationCallback) {}

      observe(target: Node) {
        ;(target as Element).querySelector('[data-slot="skeleton"]')?.remove()
      }

      disconnect() {
        disconnect()
      }
    }
    vi.stubGlobal("MutationObserver", RaceMutationObserver)
    const source = sourceCard('<span data-slot="skeleton">loading</span>')

    await expect(prepare(source)).resolves.toMatchObject({ fontEmbedCSS: FONT_CSS })
    expect(disconnect).toHaveBeenCalled()
  })

  it("propagates an external abort while waiting for the source", async () => {
    const controller = new AbortController()
    const source = sourceCard('<span data-slot="skeleton">loading</span>')
    const pending = prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      signal: controller.signal,
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("counts padded base64 data URLs while ignoring ASCII whitespace", async () => {
    const readDataUrl = vi.fn().mockResolvedValue(dataUrlResponse(new Uint8Array([7])))
    vi.stubGlobal("fetch", readDataUrl)
    const source = sourceCard('<img alt="inline">')
    source.querySelector("img")!.setAttribute("src", "data:image/png;BASE64,A\tA\f\r\n == ")

    const prepared = await prepare(source, vi.fn(), 1)

    expect(readDataUrl).toHaveBeenCalledTimes(1)
    expect(prepared.markup).toContain("data:image/png;base64,Bw==")
  })

  it("counts percent escapes and UTF-8 code points in non-base64 data URLs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dataUrlResponse(new Uint8Array([8]))))
    const source = sourceCard('<img alt="inline">')
    source.querySelector("img")!.setAttribute("src", "data:image/png,A%20é中😀")

    const prepared = await prepare(source, vi.fn(), 11)

    expect(prepared.markup).toContain("data:image/png;base64,CA==")
  })

  it("rejects malformed and unreadable data URLs atomically", async () => {
    const malformed = sourceCard('<img src="data:image/png;base64" alt="malformed">')
    await expect(prepare(malformed)).rejects.toMatchObject({ stage: "assets" })
    malformed.remove()

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    const unreadable = sourceCard('<img src="data:image/png;base64,AQ==" alt="unreadable">')
    await expect(prepare(unreadable)).rejects.toMatchObject({ stage: "assets" })
  })

  it("fails when the platform static decoder is unavailable or returns no pixels", async () => {
    vi.stubGlobal("createImageBitmap", undefined)
    const unavailable = sourceCard('<img src="/content.png">')
    await expect(prepareShareImageSession(unavailable, {
      fetchAsset: vi.fn().mockResolvedValue(imageResponse()),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "assets" })
    unavailable.remove()

    const bitmap = { width: 0, height: 2, close: vi.fn() }
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap))
    const empty = sourceCard('<img src="/empty.png">')
    await expect(prepareShareImageSession(empty, {
      fetchAsset: vi.fn().mockResolvedValue(imageResponse()),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "assets" })
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it("rejects unsupported, declared-oversized, and streamed-oversized responses", async () => {
    const unsupported = sourceCard('<img src="/asset.svg">')
    await expect(prepare(unsupported, vi.fn().mockResolvedValue(
      imageResponse(new Uint8Array([1]), "image/svg+xml"),
    ))).rejects.toMatchObject({ stage: "assets" })
    unsupported.remove()

    const declared = sourceCard('<img src="/declared.png">')
    await expect(prepare(declared, vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
    })))).rejects.toMatchObject({ stage: "assets" })
    declared.remove()

    const streamed = sourceCard('<img src="/streamed.png">')
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(oversized)
        streamController.close()
      },
    }), { headers: { "Content-Type": "image/png" } })
    await expect(prepare(streamed, vi.fn().mockResolvedValue(response)))
      .rejects.toMatchObject({ stage: "assets" })
  })

  it("reads bodyless responses and enforces their post-read size", async () => {
    const bodyless = sourceCard('<img src="/bodyless.png">')
    const bodylessResponse = {
      ok: true,
      headers: new Headers({ "Content-Type": "image/png" }),
      body: null,
      blob: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], {
        type: "image/png",
      })),
    } as unknown as Response

    await expect(prepare(bodyless, vi.fn().mockResolvedValue(bodylessResponse), 3))
      .resolves.toMatchObject({ fontEmbedCSS: FONT_CSS })
    expect(bodylessResponse.blob).toHaveBeenCalledTimes(1)
    bodyless.remove()

    const oversized = sourceCard('<img src="/bodyless-large.png">')
    const oversizedResponse = {
      ok: true,
      headers: new Headers({ "Content-Type": "image/png" }),
      body: null,
      blob: vi.fn().mockResolvedValue({
        size: 10 * 1024 * 1024 + 1,
        type: "image/png",
      } as Blob),
    } as unknown as Response
    await expect(prepare(oversized, vi.fn().mockResolvedValue(oversizedResponse)))
      .rejects.toMatchObject({ stage: "assets" })
  })

  it("fails atomically when FileReader cannot encode or read the static PNG", async () => {
    class NonStringFileReader extends EventTarget {
      result: string | ArrayBuffer | null = new ArrayBuffer(0)
      error: DOMException | null = null

      abort() {}

      readAsDataURL() {
        queueMicrotask(() => this.dispatchEvent(new Event("load")))
      }
    }
    vi.stubGlobal("FileReader", NonStringFileReader)
    const nonString = sourceCard('<img src="/non-string.png">')
    await expect(prepare(nonString, vi.fn().mockResolvedValue(imageResponse())))
      .rejects.toMatchObject({ stage: "assets" })
    nonString.remove()

    class ErrorFileReader extends EventTarget {
      result: string | ArrayBuffer | null = null
      error: DOMException | null = null

      abort() {}

      readAsDataURL() {
        queueMicrotask(() => this.dispatchEvent(new Event("error")))
      }
    }
    vi.stubGlobal("FileReader", ErrorFileReader)
    const unreadable = sourceCard('<img src="/unreadable.png">')
    await expect(prepare(unreadable, vi.fn().mockResolvedValue(imageResponse())))
      .rejects.toMatchObject({ stage: "assets" })
  })

  it("fails when installed PNG bytes have no pixels or reject decode", async () => {
    class ZeroPixelImage extends DecodableImage {
      naturalWidth = 0
    }
    vi.stubGlobal("Image", ZeroPixelImage)
    const zeroPixel = sourceCard('<img src="/zero.png">')
    await expect(prepare(zeroPixel, vi.fn().mockResolvedValue(imageResponse())))
      .rejects.toMatchObject({ stage: "assets" })
    zeroPixel.remove()

    class RejectingDecodeImage extends DecodableImage {
      decode = vi.fn().mockRejectedValue(new Error("decode rejected"))
    }
    vi.stubGlobal("Image", RejectingDecodeImage)
    const rejected = sourceCard('<img src="/rejected.png">')
    await expect(prepare(rejected, vi.fn().mockResolvedValue(imageResponse())))
      .rejects.toMatchObject({ stage: "assets" })
  })

  it("rejects a staticizer result that is not PNG", async () => {
    const source = sourceCard('<img src="/content.png">')

    await expect(prepareShareImageSession(source, {
      fetchAsset: vi.fn().mockResolvedValue(imageResponse()),
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      staticizeAsset: vi.fn().mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" })),
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "assets" })
  })

  it("replaces a bare failed identity image using its measured geometry", async () => {
    const source = sourceCard('<img data-avatar-photo-state="error" src="/avatar.png">')

    const prepared = await prepare(source, vi.fn().mockRejectedValue(new Error("offline")))

    expect(prepared.markup).toContain('data-share-identity-fallback="beam"')
    expect(prepared.markup).toContain("width: 320px")
    expect(prepared.markup).toContain("height: 180px")
    expect(prepared.markup).not.toContain("<img")
  })

  it("marks image frames ready and removes placeholders and direct statuses", async () => {
    const source = sourceCard(`
      <span data-remote-image-frame data-remote-image-state="loading">
        <img src="/content.png" loading="lazy" crossorigin="anonymous" srcset="/large.png 2x">
        <span data-remote-image-placeholder>loading</span>
        <span role="status">loading</span>
      </span>
    `)

    const prepared = await prepare(source, vi.fn().mockResolvedValue(imageResponse()))

    expect(prepared.markup).toContain('data-remote-image-state="ready"')
    expect(prepared.markup).not.toContain("data-remote-image-placeholder")
    expect(prepared.markup).not.toContain('role="status"')
    expect(prepared.markup).not.toContain("srcset=")
    expect(prepared.markup).not.toContain("crossorigin=")
    expect(prepared.markup).not.toContain("loading=")
  })

  it("loads the actual brand glyphs instead of the source-less fallback's default space", async () => {
    const primaryFace = { family: "Brand", status: "loaded" } as FontFace
    vi.mocked(document.fonts.load).mockImplementation(async (_font, text = " ") => {
      if (text === " ") throw new DOMException("Fallback font has no source", "NetworkError")
      return [primaryFace]
    })
    vi.mocked(document.fonts.check).mockReturnValue(false)
    const source = sourceCard("<span>font guard</span>")

    await expect(prepare(source)).resolves.toMatchObject({ fontEmbedCSS: FONT_CSS })
    expect(document.fonts.load).toHaveBeenCalledWith("700 14px Brand", "Alook")
    expect(document.fonts.check).not.toHaveBeenCalled()
  })

  it("keeps an empty brand font match as a hard preparation failure", async () => {
    vi.mocked(document.fonts.load).mockResolvedValue([])
    const source = sourceCard("<span>font guard</span>")
    const getFontCSS = vi.fn().mockResolvedValue(FONT_CSS)

    await expect(prepareShareImageSession(source, {
      getFontCSS,
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "fonts", timedOut: false })
    expect(getFontCSS).not.toHaveBeenCalled()
  })

  it("keeps a rejected brand font load as a hard preparation failure", async () => {
    vi.mocked(document.fonts.load).mockRejectedValue(new Error("font load rejected"))
    const source = sourceCard("<span>font guard</span>")
    const getFontCSS = vi.fn().mockResolvedValue(FONT_CSS)

    await expect(prepareShareImageSession(source, {
      getFontCSS,
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "fonts", timedOut: false })
    expect(getFontCSS).not.toHaveBeenCalled()
  })

  it("rejects invalid session byte budgets before asset preparation", async () => {
    const source = sourceCard("<span>invalid budget</span>")

    await expect(prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      maxSessionAssetBytes: 0,
      waitForPaint: vi.fn().mockResolvedValue(undefined),
    })).rejects.toMatchObject({ stage: "assets" })
  })

  it("rejects a URL image inserted after the preparation snapshot", async () => {
    const source = sourceCard("<span>late image</span>")
    let paints = 0
    const waitForPaint = vi.fn(async () => {
      paints += 1
      if (paints !== 3) return
      document.querySelector<HTMLElement>("[data-share-detached-tree] [data-share-card-source]")
        ?.insertAdjacentHTML("beforeend", '<img src="/late.png">')
    })

    await expect(prepareShareImageSession(source, {
      getFontCSS: vi.fn().mockResolvedValue(FONT_CSS),
      waitForPaint,
    })).rejects.toMatchObject({ stage: "assets" })
  })

  it("wraps an unexpected post-asset installation error as a freeze failure", async () => {
    const source = sourceCard('<img src="/content.png">')
    const removeAttribute = Element.prototype.removeAttribute
    vi.spyOn(Element.prototype, "removeAttribute").mockImplementation(function (name) {
      if (this instanceof HTMLImageElement && name === "srcset") {
        throw new Error("install failed")
      }
      return removeAttribute.call(this, name)
    })

    await expect(prepare(source, vi.fn().mockResolvedValue(imageResponse())))
      .rejects.toMatchObject({ stage: "freeze", cause: { message: "install failed" } })
  })
})

describe("capturePreparedShareImage", () => {
  it("rasterizes a detached byte-backed clone with the prepared font CSS", async () => {
    const preview = sourceCard('<img src="data:image/png;base64,AQID">')
    preview.removeAttribute("data-share-card-source")
    preview.setAttribute("data-share-card", "")
    const blob = new Blob(["png"], { type: "image/png" })
    const rasterize = vi.fn(async (node: HTMLElement) => {
      expect(node).not.toBe(preview)
      expect(node.parentElement?.dataset.shareDetachedTree).toBe("true")
      expect(node.dataset.shareCaptureTree).toBe("true")
      node.setAttribute("data-mutated-during-capture", "")
      return blob
    })

    const result = await capturePreparedShareImage(preview, FONT_CSS, rasterize)

    expect(result).toBe(blob)
    expect(rasterize).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      pixelRatio: 2,
      fontEmbedCSS: FONT_CSS,
      cacheBust: false,
      includeQueryParams: true,
    }))
    expect(preview.hasAttribute("data-mutated-during-capture")).toBe(false)
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })

  it("rejects a ready preview that still contains a URL-backed image", async () => {
    const preview = sourceCard('<img src="https://cdn.example/not-ready.png">')
    const rasterize = vi.fn()

    await expect(capturePreparedShareImage(preview, FONT_CSS, rasterize)).rejects.toMatchObject({
      stage: "rasterize",
    })
    expect(rasterize).not.toHaveBeenCalled()
  })

  it("times out a non-cooperative rasterizer and removes its detached tree", async () => {
    vi.useFakeTimers()
    const preview = sourceCard("<span>ready</span>")
    const rasterize = vi.fn(() => new Promise<Blob | null>(() => {}))
    const pending = capturePreparedShareImage(preview, FONT_CSS, rasterize, { timeoutMs: 25 })
    const assertion = expect(pending).rejects.toMatchObject({
      stage: "rasterize",
      timedOut: true,
    })

    await act(async () => vi.advanceTimersByTimeAsync(25))

    await assertion
    expect(document.querySelector("[data-share-detached-tree]")).toBeNull()
  })
})
