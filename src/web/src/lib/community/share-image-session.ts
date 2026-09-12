import type { Options as HtmlToImageOptions } from "html-to-image/lib/types"
import { getFontEmbedCSS } from "html-to-image"
import { renderFaceSvg } from "@/lib/avatar/face"

const SHARE_IMAGE_ASSET_TIMEOUT_MS = 5_000
const SHARE_IMAGE_RENDER_TIMEOUT_MS = 15_000
const SHARE_IMAGE_MAX_ASSET_BYTES = 10 * 1024 * 1024
const SHARE_IMAGE_MAX_SESSION_ASSET_BYTES = 10 * 1024 * 1024
const SHARE_IMAGE_MAX_DECODED_DIMENSION = 8_192
const SHARE_IMAGE_MAX_DECODED_PIXELS = 16 * 1024 * 1024
const SHARE_IMAGE_MAX_SESSION_DECODED_PIXELS = 16 * 1024 * 1024
const SHARE_IMAGE_MAX_STATIC_DIMENSION = 4_096
const SHARE_IMAGE_MAX_STATIC_PIXELS = 4 * 1024 * 1024
const SHARE_IMAGE_MAX_STATIC_ASSET_BYTES = 10 * 1024 * 1024
const SHARE_IMAGE_MAX_SESSION_STATIC_BYTES = 10 * 1024 * 1024
const SHARE_IMAGE_PIXEL_RATIO = 2

const THEME_PROPERTIES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--ring",
  "--font-sans",
  "--font-caveat",
  "--font-brand",
  "--radius",
  "--e1",
  "--e2",
] as const

const FROZEN_PROPERTIES = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-decoration-color",
  "text-shadow",
] as const

export type ShareImageSessionStage = "source" | "assets" | "fonts" | "freeze" | "rasterize"

export class ShareImageSessionError extends Error {
  constructor(
    readonly stage: ShareImageSessionStage,
    readonly timedOut = false,
    cause?: unknown,
  ) {
    super(`Share image ${timedOut ? "timed out" : "failed"} during ${stage}`)
    this.name = "ShareImageSessionError"
    this.cause = cause
  }
}

export type PreparedShareImageSession = Readonly<{
  markup: string
  width: number
  height: number
  backgroundColor: string
  fontEmbedCSS: string
}>

type ShareImageFetch = typeof fetch
type ShareImageFontEmbedder = typeof getFontEmbedCSS
type ShareImageRasterizer = (
  node: HTMLElement,
  options?: HtmlToImageOptions,
) => Promise<Blob | null>
type ShareImageAssetTarget = { width: number; height: number }
type ShareImageStaticizer = (
  blob: Blob,
  target: ShareImageAssetTarget,
  signal: AbortSignal,
  budget: ShareImageAssetBudget,
) => Promise<Blob>
type ShareImageStaticizeQueue = (run: () => Promise<Blob>) => Promise<Blob>

type PrepareShareImageSessionOptions = {
  fetchAsset?: ShareImageFetch
  getFontCSS?: ShareImageFontEmbedder
  maxSessionAssetBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
  staticizeAsset?: ShareImageStaticizer
  waitForPaint?: () => Promise<void>
}

type CaptureShareImageOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

type ShareImageAssetBudget = {
  maxBytes: number
  usedBytes: number
  decodedPixels: number
  staticBytes: number
}

class ShareImageSessionBudgetError extends Error {
  constructor(readonly limit: string) {
    super(`Share image assets exceed the ${limit} limit`)
    this.name = "ShareImageSessionBudgetError"
  }
}

function abortError(): DOMException {
  return new DOMException("Share image aborted", "AbortError")
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function withDeadline<T>(
  stage: ShareImageSessionStage,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (deadlineSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal)
  const controller = new AbortController()
  let timedOut = false
  let rejectInterrupted: ((reason: unknown) => void) | null = null
  const abort = () => {
    controller.abort()
    rejectInterrupted?.(abortError())
  }
  signal?.addEventListener("abort", abort, { once: true })
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject
  })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    rejectInterrupted?.(new ShareImageSessionError(stage, true))
  }, timeoutMs)
  try {
    return await Promise.race([run(controller.signal), interrupted])
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (timedOut) throw new ShareImageSessionError(stage, true, error)
    if (error instanceof ShareImageSessionError) throw error
    throw new ShareImageSessionError(stage, false, error)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.abort()
  }
}

async function waitForSource(
  node: HTMLElement,
  signal: AbortSignal,
  waitForPaint: () => Promise<void>,
): Promise<void> {
  while (node.querySelector('[data-slot="skeleton"]')) {
    await new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (node.querySelector('[data-slot="skeleton"]')) return
        observer.disconnect()
        signal.removeEventListener("abort", abort)
        resolve()
      })
      const abort = () => {
        observer.disconnect()
        reject(abortError())
      }
      observer.observe(node, { childList: true, subtree: true })
      signal.addEventListener("abort", abort, { once: true })
      if (!node.querySelector('[data-slot="skeleton"]')) {
        observer.disconnect()
        signal.removeEventListener("abort", abort)
        resolve()
      }
    })
  }
  await waitForPaint()
  throwIfAborted(signal)
  await waitForPaint()
}

function imageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.getAttribute("src") || ""
}

function imageKind(image: HTMLImageElement): "identity" | "content" {
  return image.hasAttribute("data-avatar-photo-state")
    || image.getAttribute("data-remote-image-kind") === "identity"
    ? "identity"
    : "content"
}

function assetRequest(image: HTMLImageElement): { cacheKey: string; url: string; credentials: RequestCredentials } {
  const source = imageSource(image)
  if (!source) throw new Error("Image source is missing")
  if (source.startsWith("data:")) return { cacheKey: source, url: source, credentials: "omit" }

  const sourceUrl = new URL(source, window.location.href)
  if (sourceUrl.origin === window.location.origin) {
    return { cacheKey: sourceUrl.href, url: sourceUrl.href, credentials: "same-origin" }
  }
  if (imageKind(image) === "content") {
    return { cacheKey: sourceUrl.href, url: sourceUrl.href, credentials: "omit" }
  }

  const identityId = image.closest<HTMLElement>("[data-share-identity-id]")
    ?.dataset.shareIdentityId
  if (!identityId) throw new Error("External identity has no visible profile id")
  const url = `/api/community/share-image/avatar/${encodeURIComponent(identityId)}`
  return { cacheKey: `${url}:${sourceUrl.href}`, url, credentials: "same-origin" }
}

function consumeAssetBytes(budget: ShareImageAssetBudget, byteLength: number): void {
  if (byteLength > budget.maxBytes - budget.usedBytes) {
    throw new ShareImageSessionBudgetError("raw session bytes")
  }
  budget.usedBytes += byteLength
}

function consumeDecodedPixels(budget: ShareImageAssetBudget, width: number, height: number): void {
  const pixels = width * height
  if (
    width > SHARE_IMAGE_MAX_DECODED_DIMENSION
    || height > SHARE_IMAGE_MAX_DECODED_DIMENSION
    || pixels > SHARE_IMAGE_MAX_DECODED_PIXELS
    || pixels > SHARE_IMAGE_MAX_SESSION_DECODED_PIXELS - budget.decodedPixels
  ) {
    throw new ShareImageSessionBudgetError("decoded pixel")
  }
  budget.decodedPixels += pixels
}

function consumeStaticBytes(budget: ShareImageAssetBudget, byteLength: number): void {
  if (
    byteLength > SHARE_IMAGE_MAX_STATIC_ASSET_BYTES
    || byteLength > SHARE_IMAGE_MAX_SESSION_STATIC_BYTES - budget.staticBytes
  ) {
    throw new ShareImageSessionBudgetError("static PNG byte")
  }
  budget.staticBytes += byteLength
}

function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  if (comma < 0) throw new Error("Image data URL is malformed")
  const metadata = dataUrl.slice(0, comma).toLowerCase()
  const payload = dataUrl.slice(comma + 1)
  if (metadata.split(";").includes("base64")) {
    let encodedLength = 0
    let last = ""
    let penultimate = ""
    for (let index = 0; index < payload.length; index += 1) {
      const code = payload.charCodeAt(index)
      if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) continue
      encodedLength += 1
      penultimate = last
      last = payload[index]!
    }
    const padding = last === "=" ? (penultimate === "=" ? 2 : 1) : 0
    return Math.max(0, Math.floor(encodedLength * 3 / 4) - padding)
  }

  let byteLength = 0
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index)
    if (code === 37 && /^[\da-f]{2}$/i.test(payload.slice(index + 1, index + 3))) {
      byteLength += 1
      index += 2
      continue
    }
    const codePoint = payload.codePointAt(index)!
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (codePoint > 0xffff) index += 1
  }
  return byteLength
}

function assetTarget(image: HTMLImageElement): ShareImageAssetTarget {
  const rect = image.getBoundingClientRect()
  return {
    width: Math.max(0, Math.ceil(rect.width * SHARE_IMAGE_PIXEL_RATIO)),
    height: Math.max(0, Math.ceil(rect.height * SHARE_IMAGE_PIXEL_RATIO)),
  }
}

function mergeAssetTarget(
  targets: Map<string, ShareImageAssetTarget>,
  cacheKey: string,
  target: ShareImageAssetTarget,
): void {
  const current = targets.get(cacheKey)
  targets.set(cacheKey, {
    width: Math.max(current?.width ?? 0, target.width),
    height: Math.max(current?.height ?? 0, target.height),
  })
}

function staticImageSize(
  sourceWidth: number,
  sourceHeight: number,
  target: ShareImageAssetTarget,
): ShareImageAssetTarget {
  const targetWidth = target.width > 0 ? target.width : SHARE_IMAGE_MAX_STATIC_DIMENSION
  const targetHeight = target.height > 0 ? target.height : SHARE_IMAGE_MAX_STATIC_DIMENSION
  const scale = Math.min(
    1,
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
    SHARE_IMAGE_MAX_STATIC_DIMENSION / sourceWidth,
    SHARE_IMAGE_MAX_STATIC_DIMENSION / sourceHeight,
    Math.sqrt(SHARE_IMAGE_MAX_STATIC_PIXELS / (sourceWidth * sourceHeight)),
  )
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
  }
}

function canvasToPng(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (blob?: Blob | null, error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      if (error) reject(error)
      else if (!blob || blob.size === 0) reject(new Error("Static PNG encoder returned no image"))
      else resolve(blob)
    }
    const abort = () => finish(undefined, abortError())
    signal.addEventListener("abort", abort, { once: true })
    canvas.toBlob(
      (blob) => finish(blob),
      "image/png",
    )
  })
}

async function staticizeImageBlob(
  blob: Blob,
  target: ShareImageAssetTarget,
  signal: AbortSignal,
  budget: ShareImageAssetBudget,
): Promise<Blob> {
  throwIfAborted(signal)
  if (typeof createImageBitmap !== "function") {
    throw new Error("Static image decoding is unavailable")
  }
  const bitmap = await createImageBitmap(blob)
  let canvas: HTMLCanvasElement | null = null
  try {
    throwIfAborted(signal)
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      throw new Error("Decoded image has no pixels")
    }
    consumeDecodedPixels(budget, bitmap.width, bitmap.height)
    const size = staticImageSize(bitmap.width, bitmap.height, target)
    canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Static image canvas is unavailable")
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    return await canvasToPng(canvas, signal)
  } finally {
    bitmap.close()
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}

async function dataUrlBlob(dataUrl: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(dataUrl, { signal })
  if (!response.ok) throw new Error("Image data URL could not be read")
  return response.blob()
}

async function readImageResponse(
  response: Response,
  signal: AbortSignal,
  budget: ShareImageAssetBudget,
): Promise<Blob> {
  if (!response.ok) throw new Error(`Image request returned ${response.status}`)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (!contentType?.startsWith("image/") || contentType === "image/svg+xml") {
    throw new Error("Image request returned an unsupported content type")
  }
  const declaredSize = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredSize) && declaredSize > SHARE_IMAGE_MAX_ASSET_BYTES) {
    throw new Error("Image response is too large")
  }
  if (!response.body) {
    const blob = await response.blob()
    if (blob.size > SHARE_IMAGE_MAX_ASSET_BYTES) throw new Error("Image response is too large")
    consumeAssetBytes(budget, blob.size)
    return blob.type ? blob : new Blob([blob], { type: contentType })
  }

  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel(abortError()).catch(() => undefined)
  }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await reader.read()
      throwIfAborted(signal)
      if (result.done) break
      size += result.value.byteLength
      if (size > SHARE_IMAGE_MAX_ASSET_BYTES) {
        await reader.cancel()
        throw new Error("Image response is too large")
      }
      try {
        consumeAssetBytes(budget, result.value.byteLength)
      } catch (error) {
        void reader.cancel(error).catch(() => undefined)
        throw error
      }
      chunks.push(result.value)
    }
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  const bytes = new ArrayBuffer(size)
  const view = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    view.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Blob([bytes], { type: contentType })
}

function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => {
      reader.abort()
      reject(abortError())
    }
    reader.addEventListener("load", () => {
      signal.removeEventListener("abort", abort)
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("Image bytes could not be encoded"))
    }, { once: true })
    reader.addEventListener("error", () => {
      signal.removeEventListener("abort", abort)
      reject(reader.error ?? new Error("Image bytes could not be read"))
    }, { once: true })
    signal.addEventListener("abort", abort, { once: true })
    reader.readAsDataURL(blob)
  })
}

function decodeDataUrl(dataUrl: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      image.onload = null
      image.onerror = null
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(abortError())
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        finish(new Error("Decoded image has no pixels"))
        return
      }
      Promise.resolve(image.decode?.()).then(
        () => finish(),
        (error) => finish(error),
      )
    }
    image.onerror = () => finish(new Error("Image bytes could not be decoded"))
    signal.addEventListener("abort", abort, { once: true })
    image.src = dataUrl
  })
}

async function resolveImage(
  image: HTMLImageElement,
  fetchAsset: ShareImageFetch,
  signal: AbortSignal,
  assetCache: Map<string, Promise<string>>,
  assetTargets: Map<string, ShareImageAssetTarget>,
  budget: ShareImageAssetBudget,
  staticizeAsset: ShareImageStaticizer,
  enqueueStaticize: ShareImageStaticizeQueue,
): Promise<string | null> {
  const kind = imageKind(image)
  try {
    const request = assetRequest(image)
    const cached = assetCache.get(request.cacheKey)
    if (cached) return await cached
    const pending = (async () => {
      let blob: Blob
      if (request.url.startsWith("data:")) {
        consumeAssetBytes(budget, dataUrlByteLength(request.url))
        blob = await dataUrlBlob(request.url, signal)
      } else {
        const response = await fetchAsset(request.url, {
          credentials: request.credentials,
          redirect: "error",
          signal,
        })
        blob = await readImageResponse(response, signal, budget)
      }
      const staticBlob = await enqueueStaticize(() => staticizeAsset(
        blob,
        assetTargets.get(request.cacheKey) ?? assetTarget(image),
        signal,
        budget,
      ))
      if (staticBlob.type !== "image/png") {
        throw new Error("Static image encoder returned a non-PNG image")
      }
      consumeStaticBytes(budget, staticBlob.size)
      const dataUrl = await blobToDataUrl(staticBlob, signal)
      await decodeDataUrl(dataUrl, signal)
      return dataUrl
    })()
    assetCache.set(request.cacheKey, pending)
    return await pending
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (error instanceof ShareImageSessionBudgetError) throw error
    if (kind === "identity") return null
    throw error
  }
}

function replaceIdentityWithFallback(image: HTMLImageElement): void {
  const identityRoot = image.closest<HTMLElement>("[data-share-identity-id]")
  const fallbackRoot = image.closest<HTMLElement>("[data-avatar-kind], [role=img]")
    ?? identityRoot
  const seed = identityRoot?.dataset.shareIdentityId
    || fallbackRoot?.getAttribute("aria-label")
    || imageSource(image)
  const replacement = image.ownerDocument.createElement("span")
  replacement.dataset.shareIdentityFallback = "beam"
  replacement.setAttribute("aria-hidden", "true")
  replacement.style.cssText = "display:inline-flex;width:100%;height:100%;overflow:hidden;border-radius:inherit"
  replacement.innerHTML = renderFaceSvg(seed)
  if (fallbackRoot) {
    fallbackRoot.replaceChildren(replacement)
    fallbackRoot.dataset.avatarKind = "beam"
    return
  }
  const rect = image.getBoundingClientRect()
  replacement.style.width = `${rect.width}px`
  replacement.style.height = `${rect.height}px`
  image.replaceWith(replacement)
}

function installImageBytes(image: HTMLImageElement, dataUrl: string): void {
  image.src = dataUrl
  image.removeAttribute("srcset")
  image.removeAttribute("crossorigin")
  image.removeAttribute("loading")
  image.style.opacity = "1"
  image.dataset.shareByteBacked = "true"
  image.dataset.remoteImageState = "ready"
  const frame = image.closest<HTMLElement>(
    "[data-remote-image-frame], [data-streamdown=image-wrapper], [data-avatar-kind]",
  )
  if (!frame) return
  frame.dataset.remoteImageState = "ready"
  for (const placeholder of frame.querySelectorAll("[data-remote-image-placeholder]")) {
    placeholder.remove()
  }
  for (const status of frame.querySelectorAll(':scope > [role="status"]')) status.remove()
}

function freezeTree(root: HTMLElement): { width: number; height: number; backgroundColor: string } {
  const rect = root.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error("Share card has no layout")
  const rootStyle = getComputedStyle(root)
  for (const property of THEME_PROPERTIES) {
    const value = rootStyle.getPropertyValue(property).trim()
    if (value) root.style.setProperty(property, value)
  }
  root.style.width = `${rect.width}px`
  root.style.height = `${rect.height}px`
  root.style.minWidth = `${rect.width}px`
  root.style.maxWidth = `${rect.width}px`
  root.style.boxSizing = "border-box"

  const elements = [root, ...root.querySelectorAll<HTMLElement>("*")]
  for (const element of elements) {
    const computed = getComputedStyle(element)
    for (const property of FROZEN_PROPERTIES) {
      const value = computed.getPropertyValue(property)
      if (value) element.style.setProperty(property, value)
    }
    element.style.setProperty("animation", "none", "important")
    element.style.setProperty("transition", "none", "important")
    element.style.setProperty("caret-color", "transparent")
  }
  root.dataset.shareSessionState = "ready"
  return {
    width: rect.width,
    height: rect.height,
    backgroundColor: rootStyle.getPropertyValue("--card").trim() || rootStyle.backgroundColor,
  }
}

function mountDetached(source: HTMLElement): { host: HTMLDivElement; card: HTMLElement } {
  const sourceRect = source.getBoundingClientRect()
  const host = document.createElement("div")
  host.dataset.shareDetachedTree = "true"
  host.setAttribute("aria-hidden", "true")
  host.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${Math.max(1, sourceRect.width)}px`,
    "pointer-events:none",
    "opacity:0",
    "z-index:-1",
  ].join(";")
  const card = source.cloneNode(true) as HTMLElement
  host.appendChild(card)
  document.body.appendChild(host)
  return { host, card }
}

async function loadAndEmbedFonts(
  card: HTMLElement,
  getFontCSS: ShareImageFontEmbedder,
  signal: AbortSignal,
): Promise<string> {
  const brand = card.querySelector<HTMLElement>("[data-share-brand]")
  const primaryFontFamily = brand?.dataset.shareBrandFont?.trim()
  if (!brand || !primaryFontFamily) throw new Error("Share-card brand font is missing")
  const loadedFaces = await document.fonts.load(
    `700 14px ${JSON.stringify(primaryFontFamily)}`,
    brand.textContent.trim(),
  )
  if (loadedFaces.length === 0) throw new Error("Brand font is unavailable")
  await document.fonts.ready
  throwIfAborted(signal)
  const css = await getFontCSS(card)
  if (!css.trim()) throw new Error("Share-card fonts could not be embedded")
  return css
}

export async function prepareShareImageSession(
  source: HTMLElement,
  options: PrepareShareImageSessionOptions = {},
): Promise<PreparedShareImageSession> {
  const timeoutMs = options.timeoutMs ?? SHARE_IMAGE_ASSET_TIMEOUT_MS
  const waitForPaint = options.waitForPaint ?? nextPaint
  await withDeadline("source", timeoutMs, options.signal, (signal) => (
    waitForSource(source, signal, waitForPaint)
  ))
  throwIfAborted(options.signal)

  const { host, card } = mountDetached(source)
  try {
    const maxSessionAssetBytes = options.maxSessionAssetBytes ?? SHARE_IMAGE_MAX_SESSION_ASSET_BYTES
    if (!Number.isSafeInteger(maxSessionAssetBytes) || maxSessionAssetBytes <= 0) {
      throw new ShareImageSessionError("assets", false, new Error("Session asset limit is invalid"))
    }
    const images = [...card.querySelectorAll<HTMLImageElement>("img")]
    const assetCache = new Map<string, Promise<string>>()
    const budget: ShareImageAssetBudget = {
      maxBytes: maxSessionAssetBytes,
      usedBytes: 0,
      decodedPixels: 0,
      staticBytes: 0,
    }
    let staticizeTail = Promise.resolve()
    const enqueueStaticize: ShareImageStaticizeQueue = (run) => {
      const result = staticizeTail.then(run, run)
      staticizeTail = result.then(() => undefined, () => undefined)
      return result
    }
    const resolved = await withDeadline("assets", timeoutMs, options.signal, async (signal) => {
      await waitForPaint()
      throwIfAborted(signal)
      const assetTargets = new Map<string, ShareImageAssetTarget>()
      for (const image of images) {
        try {
          const request = assetRequest(image)
          mergeAssetTarget(assetTargets, request.cacheKey, assetTarget(image))
        } catch {
          // Preserve the existing per-image content failure / identity fallback semantics.
        }
      }
      return Promise.all(images.map((image) => resolveImage(
        image,
        options.fetchAsset ?? fetch,
        signal,
        assetCache,
        assetTargets,
        budget,
        options.staticizeAsset ?? staticizeImageBlob,
        enqueueStaticize,
      )))
    })
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!
      const dataUrl = resolved[index]
      if (dataUrl) installImageBytes(image, dataUrl)
      else replaceIdentityWithFallback(image)
    }
    if ([...card.querySelectorAll<HTMLImageElement>("img")].some((image) => (
      !imageSource(image).startsWith("data:")
    ))) {
      throw new ShareImageSessionError("assets", false, new Error("Session contains a URL image"))
    }

    const fontEmbedCSS = await withDeadline("fonts", timeoutMs, options.signal, (signal) => (
      loadAndEmbedFonts(card, options.getFontCSS ?? getFontEmbedCSS, signal)
    ))
    const frozen = await withDeadline("freeze", timeoutMs, options.signal, async (signal) => {
      await waitForPaint()
      throwIfAborted(signal)
      card.removeAttribute("data-share-card-source")
      card.setAttribute("data-share-card", "")
      return freezeTree(card)
    })
    return Object.freeze({
      markup: card.outerHTML,
      ...frozen,
      fontEmbedCSS,
    })
  } catch (error) {
    if (error instanceof ShareImageSessionError || (error as { name?: unknown })?.name === "AbortError") {
      throw error
    }
    throw new ShareImageSessionError("freeze", false, error)
  } finally {
    host.remove()
  }
}

export async function capturePreparedShareImage(
  source: HTMLElement,
  fontEmbedCSS: string,
  rasterize: ShareImageRasterizer,
  options: CaptureShareImageOptions = {},
): Promise<Blob> {
  const timeoutMs = options.timeoutMs ?? SHARE_IMAGE_RENDER_TIMEOUT_MS
  return withDeadline("rasterize", timeoutMs, options.signal, async (signal) => {
    if ([...source.querySelectorAll<HTMLImageElement>("img")].some((image) => (
      !imageSource(image).startsWith("data:")
    ))) {
      throw new Error("Ready share session contains a URL image")
    }
    const { host, card } = mountDetached(source)
    const removeHost = () => host.remove()
    signal.addEventListener("abort", removeHost, { once: true })
    try {
      card.dataset.shareCaptureTree = "true"
      for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        element.style.setProperty("animation", "none", "important")
        element.style.setProperty("transition", "none", "important")
      }
      throwIfAborted(signal)
      const blob = await rasterize(card, {
        pixelRatio: SHARE_IMAGE_PIXEL_RATIO,
        backgroundColor: getComputedStyle(card).getPropertyValue("--card").trim() || undefined,
        fontEmbedCSS,
        includeQueryParams: true,
        cacheBust: false,
      })
      throwIfAborted(signal)
      if (!blob) throw new Error("Rasterizer returned no image")
      return blob
    } finally {
      signal.removeEventListener("abort", removeHost)
      removeHost()
    }
  })
}
