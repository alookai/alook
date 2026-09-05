"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import { Check, Copy, Download, Highlighter, Loader2 } from "lucide-react"
import { writeImage } from "@tauri-apps/plugin-clipboard-manager"
import { isDesktop, isTauri, stripInlineMarkup } from "@alook/shared"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import { MessageBody } from "./message-body"
import { attachmentAspectRatio } from "./attachment-layout"
import { tid } from "@/lib/community/testids"
import { applyHighlightToRange, clearHighlights, hasHighlights } from "@/lib/community/highlight-range"
import type { RenderMsg } from "@/lib/community/models/message"
import { displayReplyContent } from "@/lib/community/reply-content"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"

const SHARE_IMAGE_READY_TIMEOUT_MS = 5_000
const SHARE_IMAGE_RENDER_TIMEOUT_MS = 15_000
const SHARE_IMAGE_PIXEL_RATIO = 2

export type ShareCardRenderStage = "snapshot" | "fonts" | "rasterize" | "cleanup"

export class ShareCardRenderError extends Error {
  constructor(
    readonly stage: ShareCardRenderStage,
    readonly timedOut = false,
    cause?: unknown,
  ) {
    super(`Share-card render ${timedOut ? "timed out" : "failed"} during ${stage}`)
    this.name = "ShareCardRenderError"
    this.cause = cause
  }
}

export class ShareCardImageTimeoutError extends Error {
  constructor() {
    super("A share-card image did not finish loading in time")
    this.name = "ShareCardImageTimeoutError"
  }
}

export class ShareImageSnapshotError extends Error {
  constructor() {
    super("Share-card image pixels are not readable")
    this.name = "ShareImageSnapshotError"
  }
}

export type ShareCardImageDisposition = {
  image: HTMLImageElement
  mode: "snapshot" | "fallback"
}

function createShareCardAbortError(): DOMException {
  return new DOMException("Share-card render aborted", "AbortError")
}

function isProfilePhoto(image: HTMLImageElement): boolean {
  return image.hasAttribute("data-avatar-photo-state")
}

function isFailedProfilePhoto(image: HTMLImageElement): boolean {
  return image.getAttribute("data-avatar-photo-state") === "failed"
}

async function waitForImageLoad(
  image: HTMLImageElement,
  deadline: number,
  signal?: AbortSignal,
): Promise<ShareCardImageDisposition["mode"]> {
  const fallbackOrThrow = (error: Error): ShareCardImageDisposition["mode"] => {
    if (isProfilePhoto(image)) return "fallback"
    throw error
  }
  if (signal?.aborted) throw createShareCardAbortError()
  if (isFailedProfilePhoto(image)) return "fallback"

  if (!image.complete) {
    const result = await new Promise<"loaded" | "error" | "timeout" | "aborted">((resolve) => {
      let finished = false
      const finish = (result: "loaded" | "error" | "timeout" | "aborted") => {
        if (finished) return
        finished = true
        image.removeEventListener("load", loaded)
        image.removeEventListener("error", failed)
        signal?.removeEventListener("abort", aborted)
        clearTimeout(timer)
        resolve(result)
      }
      const loaded = () => finish("loaded")
      const failed = () => finish("error")
      const aborted = () => finish("aborted")
      const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()))
      image.addEventListener("load", loaded, { once: true })
      image.addEventListener("error", failed, { once: true })
      signal?.addEventListener("abort", aborted, { once: true })
      if (image.complete) finish(image.naturalWidth > 0 ? "loaded" : "error")
      else if (signal?.aborted) finish("aborted")
    })
    if (result === "aborted") throw createShareCardAbortError()
    if (result === "timeout") return fallbackOrThrow(new ShareCardImageTimeoutError())
    if (result === "error") return fallbackOrThrow(new ShareImageSnapshotError())
  }
  if (isFailedProfilePhoto(image)) return "fallback"
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return fallbackOrThrow(new ShareImageSnapshotError())
  }
  if (image.decode) {
    const result = await new Promise<"decoded" | "failed" | "timeout" | "aborted">((resolve) => {
      let finished = false
      const finish = (result: "decoded" | "failed" | "timeout" | "aborted") => {
        if (finished) return
        finished = true
        signal?.removeEventListener("abort", aborted)
        clearTimeout(timer)
        resolve(result)
      }
      const aborted = () => finish("aborted")
      const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()))
      signal?.addEventListener("abort", aborted, { once: true })
      Promise.resolve().then(() => image.decode()).then(
        () => finish("decoded"),
        () => finish("failed"),
      )
      if (signal?.aborted) finish("aborted")
    })
    if (result === "aborted") throw createShareCardAbortError()
    if (isFailedProfilePhoto(image)) return "fallback"
    if (result !== "decoded" && isProfilePhoto(image)) return "fallback"
  }
  return "snapshot"
}

function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export async function waitForShareCardImages(
  node: HTMLElement,
  waitForPaint: () => Promise<void> = nextPaint,
  timeoutMs = SHARE_IMAGE_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ShareCardImageDisposition[]> {
  const deadline = Date.now() + timeoutMs
  const dispositions = await Promise.all(
    [...node.querySelectorAll("img")].map(async (image) => ({
      image,
      mode: await waitForImageLoad(image, deadline, signal),
    })),
  )
  if (signal?.aborted) throw createShareCardAbortError()
  await waitForPaint()
  if (signal?.aborted) throw createShareCardAbortError()
  return dispositions
}

type ShareImageWaiter = (
  node: HTMLElement,
  waitForPaint?: () => Promise<void>,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<ShareCardImageDisposition[]>
type ShareImageSnapshotter = (image: HTMLImageElement) => HTMLCanvasElement | null

function copySnapshotPresentation(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  canvas.className = image.className
  canvas.style.cssText = image.style.cssText
  for (const attribute of [...image.attributes]) {
    if (attribute.name.startsWith("data-") || attribute.name.startsWith("aria-")) {
      canvas.setAttribute(attribute.name, attribute.value)
    }
  }
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
}

function drawShareImageSnapshot(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  objectFit: string,
): void {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new ShareImageSnapshotError()
  }
  const context = canvas.getContext("2d")
  if (!context) throw new ShareImageSnapshotError()

  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight
  const targetWidth = canvas.width
  const targetHeight = canvas.height
  const containScale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const coverScale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const scale = objectFit === "contain"
    ? containScale
    : objectFit === "cover"
      ? coverScale
      : objectFit === "none"
        ? SHARE_IMAGE_PIXEL_RATIO
        : objectFit === "scale-down"
          ? Math.min(SHARE_IMAGE_PIXEL_RATIO, containScale)
          : null

  if (scale === null) {
    context.drawImage(image, 0, 0, targetWidth, targetHeight)
    return
  }

  const width = sourceWidth * scale
  const height = sourceHeight * scale
  context.drawImage(
    image,
    (targetWidth - width) / 2,
    (targetHeight - height) / 2,
    width,
    height,
  )
}

export function createShareImageSnapshot(image: HTMLImageElement): HTMLCanvasElement | null {
  const rect = image.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  const createCanvas = () => {
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(rect.width * SHARE_IMAGE_PIXEL_RATIO))
    canvas.height = Math.max(1, Math.round(rect.height * SHARE_IMAGE_PIXEL_RATIO))
    copySnapshotPresentation(image, canvas, rect.width, rect.height)
    return canvas
  }

  const canvas = createCanvas()
  try {
    drawShareImageSnapshot(image, canvas, getComputedStyle(image).objectFit)
    canvas.toDataURL()
    return canvas
  } catch {
    throw new ShareImageSnapshotError()
  }
}

export async function snapshotShareCardImages(
  node: HTMLElement,
  createSnapshot: ShareImageSnapshotter = createShareImageSnapshot,
  waitForImages: ShareImageWaiter = waitForShareCardImages,
  waitForPaint: () => Promise<void> = nextPaint,
  signal?: AbortSignal,
): Promise<() => void> {
  const dispositions = await waitForImages(node, undefined, undefined, signal)
  const replacements: Array<{ image: HTMLImageElement; replacement: Element }> = []
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    for (const { image, replacement } of replacements.reverse()) {
      if (replacement.parentNode) replacement.replaceWith(image)
    }
  }

  try {
    for (const { image, mode } of dispositions) {
      if (!image.parentNode) continue
      if (mode === "fallback") {
        const placeholder = document.createElement("span")
        placeholder.hidden = true
        image.replaceWith(placeholder)
        replacements.push({ image, replacement: placeholder })
        continue
      }
      const canvas = createSnapshot(image)
      if (!canvas) continue
      image.replaceWith(canvas)
      replacements.push({ image, replacement: canvas })
    }
    if (signal?.aborted) throw createShareCardAbortError()
    await waitForPaint()
    if (signal?.aborted) throw createShareCardAbortError()
    return restore
  } catch (error) {
    restore()
    throw error
  }
}

type ShareCardImageSnapshotter = (
  node: HTMLElement,
  signal?: AbortSignal,
) => Promise<() => void>
type ShareCardRasterizer = typeof toBlob
type ShareCardRenderOptions = {
  timeoutMs?: number
  loadFonts?: () => Promise<void>
  onStage?: (stage: ShareCardRenderStage) => void
  signal?: AbortSignal
}

function snapshotShareCardImagesForRender(
  node: HTMLElement,
  signal?: AbortSignal,
): Promise<() => void> {
  return snapshotShareCardImages(
    node,
    createShareImageSnapshot,
    waitForShareCardImages,
    nextPaint,
    signal,
  )
}

async function loadShareCardFonts(): Promise<void> {
  const caveatFont = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-caveat")
    .trim()
  if (document.fonts?.load && caveatFont) await document.fonts.load(`16px ${caveatFont}`)
  await document.fonts?.ready
}

export async function renderShareCard(
  node: HTMLElement,
  snapshotImages: ShareCardImageSnapshotter = snapshotShareCardImagesForRender,
  rasterize: ShareCardRasterizer = toBlob,
  options: ShareCardRenderOptions = {},
): Promise<Blob> {
  const timeoutMs = options.timeoutMs ?? SHARE_IMAGE_RENDER_TIMEOUT_MS
  const loadFonts = options.loadFonts ?? loadShareCardFonts
  let stage: ShareCardRenderStage = "snapshot"
  let restoreImages: (() => void) | null = null
  let cleanupRequested = false
  let cleanupComplete = false
  let stopped = false
  let terminalError: Error | null = null

  const enterStage = (nextStage: ShareCardRenderStage) => {
    stage = nextStage
    options.onStage?.(nextStage)
  }
  const cleanup = () => {
    cleanupRequested = true
    if (!restoreImages || cleanupComplete) return
    enterStage("cleanup")
    cleanupComplete = true
    restoreImages()
  }

  enterStage("snapshot")
  let rejectDeadline!: (reason: Error) => void
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const stop = (error: Error) => {
    if (stopped) return
    stopped = true
    terminalError = error
    try {
      cleanup()
      rejectDeadline(error)
    } catch (cleanupError) {
      terminalError = new ShareCardRenderError("cleanup", false, cleanupError)
      rejectDeadline(terminalError)
    }
  }
  const timer = setTimeout(
    () => stop(new ShareCardRenderError(stage, true)),
    timeoutMs,
  )
  const abort = () => stop(createShareCardAbortError())
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })

  const lifecycle = async (): Promise<Blob> => {
    try {
      restoreImages = await snapshotImages(node, options.signal)
      if (cleanupRequested) cleanup()
      if (terminalError) throw terminalError

      enterStage("fonts")
      try {
        await loadFonts()
      } catch {
        // Font loading is best-effort; the fallback font is still renderable.
      }
      if (terminalError) throw terminalError

      enterStage("rasterize")
      const blob = await rasterize(node, {
        pixelRatio: SHARE_IMAGE_PIXEL_RATIO,
        fetchRequestInit: { credentials: "same-origin" },
        // Solid backdrop so the exported PNG never bleeds transparent corners
        // (the card's own rounded bg sits on top of this).
        backgroundColor: getComputedStyle(node).getPropertyValue("--card")?.trim() || undefined,
      })
      if (terminalError) throw terminalError
      if (!blob) throw new Error("Rasterizer returned no image")
      return blob
    } catch (error) {
      if (error instanceof ShareCardRenderError) throw error
      throw new ShareCardRenderError(stage, false, error)
    } finally {
      try {
        cleanup()
      } catch (error) {
        throw new ShareCardRenderError("cleanup", false, error)
      }
    }
  }

  try {
    return await Promise.race([lifecycle(), deadline])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

type ShareCardRenderer = () => Promise<Blob | null>
type ShareCardBlobWriter = (blob: Blob) => Promise<void> | void

export async function writeShareCardToClipboard(blob: Blob): Promise<void> {
  if (isTauri() && isDesktop()) {
    await writeImage(await blob.arrayBuffer())
    return
  }

  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ])
}

export async function copyRenderedShareCard(
  render: ShareCardRenderer,
  write: ShareCardBlobWriter = writeShareCardToClipboard,
): Promise<void> {
  const blob = await render()
  if (!blob) throw new ShareCardRenderError("rasterize")
  await write(blob)
}

async function saveShareCardDownload(
  blob: Blob,
  filename: string,
  save: ShareCardBlobWriter = (value) => {
    const url = URL.createObjectURL(value)
    try {
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      anchor.click()
    } finally {
      URL.revokeObjectURL(url)
    }
  },
): Promise<void> {
  await save(blob)
}

export async function downloadRenderedShareCard(
  render: ShareCardRenderer,
  filename: string,
  save?: ShareCardBlobWriter,
): Promise<void> {
  const blob = await render()
  if (!blob) throw new ShareCardRenderError("rasterize")
  await saveShareCardDownload(blob, filename, save)
}

export function shareCardRenderErrorMessage(error: unknown): string | null {
  if (!(error instanceof ShareCardRenderError)) return null
  const stage = {
    snapshot: "preparing images",
    fonts: "loading fonts",
    rasterize: "rendering the image",
    cleanup: "restoring the preview",
  }[error.stage]
  return error.timedOut
    ? `Couldn't generate image — ${stage} took too long`
    : `Couldn't generate image — ${stage} failed`
}

type ShareCardExportFlight = {
  id: number
  controller: AbortController
  promise: Promise<void>
}

// Share one OR several messages as an image. Renders a self-contained "share
// card" that mirrors the in-app message blob(s) (avatar / name / content — NO
// timestamp, per spec) plus an Alook brand footer, then rasterises THAT SAME
// node to PNG (WYSIWYG) via html-to-image — fully client-side, no backend. The
// captured node has a fixed width and its own solid background so the export is
// stable regardless of the surrounding theme surface.
//
// Multi-message (Gus uiux #128, Alli #133): pass an array of the selected
// messages (in order). Consecutive same-author messages collapse the avatar/
// name (each carries `grouped`, computed by the message list — reused verbatim),
// exactly like the chat stream. Everything else — toBlob capture, Download/Copy,
// drag-highlight — is shared; highlight is per-message (each body its own ref).
export function MessageShareDialog({ m, open, onClose }: {
  m: RenderMsg | RenderMsg[]
  open: boolean
  onClose: () => void
}) {
  const messages = useMemo(() => (Array.isArray(m) ? m : [m]), [m])
  const profilesByUserId = useProfilesByUserId()
  const cardRef = useRef<HTMLDivElement>(null)
  // One body wrapper per message — highlight operations are scoped to the body
  // the drag happened in, so a drag never wraps the avatar/name/footer OR bleeds
  // across messages (Alli #133: highlight is per-message). Keyed by message id.
  const bodyRefs = useRef(new Map<string, HTMLDivElement | null>())
  const exportOwnerRef = useRef<{
    generation: number
    active: ShareCardExportFlight | null
  }>({ generation: 0, active: null })
  const copiedTimerRef = useRef<number | null>(null)
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)
  // Drives the Reset button's presence. Gus (uiux #95): the button is HIDDEN
  // (not disabled) when there's nothing to reset — "less is more". Mirrors the
  // DOM (any `mark[data-hl]` across the bodies) after each apply/reset.
  const [highlighted, setHighlighted] = useState(false)

  const anyHighlight = useCallback(
    () => [...bodyRefs.current.values()].some((b) => b && hasHighlights(b)),
    [],
  )

  // On mouseup inside a message body, wrap the current selection in a highlight.
  // Text-node-level wrapping (see highlight-range.ts) — never surroundContents,
  // so it survives spanning multiple markdown elements. Drags stack; the browser
  // selection is collapsed afterward so it doesn't also land in the PNG. Scoped
  // to the one body the drag is in — a selection straying outside it is ignored.
  const onBodyMouseUp = useCallback((id: string) => {
    const body = bodyRefs.current.get(id)
    if (!body) return
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) return
    const added = applyHighlightToRange(body, range)
    sel.removeAllRanges()
    if (added > 0) setHighlighted(anyHighlight())
  }, [anyHighlight])

  const resetHighlights = useCallback(() => {
    for (const body of bodyRefs.current.values()) if (body) clearHighlights(body)
    setHighlighted(false)
  }, [])

  const invalidateExport = useCallback(() => {
    const owner = exportOwnerRef.current
    owner.generation += 1
    owner.active?.controller.abort()
    owner.active = null
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) invalidateExport()
  }, [invalidateExport, open])

  useEffect(() => () => invalidateExport(), [invalidateExport])

  const startExport = useCallback((action: "copy" | "download"): Promise<void> => {
    const owner = exportOwnerRef.current
    if (owner.active) return owner.active.promise

    const id = owner.generation + 1
    const controller = new AbortController()
    const flight: ShareCardExportFlight = {
      id,
      controller,
      promise: Promise.resolve(),
    }
    owner.generation = id
    owner.active = flight
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
    setCopied(false)
    setBusy(action)

    const firstAuthorId = messages[0]?.authorId
    const firstAuthor = firstAuthorId
      ? readCommunityProfile(profilesByUserId.get(firstAuthorId), firstAuthorId)
      : null
    const filename = `alook-message-${firstAuthor?.name ?? "share"}.png`
    const isCurrent = () => (
      exportOwnerRef.current.generation === id && !controller.signal.aborted
    )

    flight.promise = (async () => {
      try {
        const node = cardRef.current
        if (!node) throw new ShareCardRenderError("rasterize")
        const blob = await renderShareCard(node, undefined, undefined, {
          signal: controller.signal,
        })
        if (!isCurrent()) return

        if (action === "copy") await writeShareCardToClipboard(blob)
        else await saveShareCardDownload(blob, filename)
        if (!isCurrent()) return

        if (action === "copy") {
          setCopied(true)
          toast.success("Image copied to clipboard")
          copiedTimerRef.current = window.setTimeout(() => {
            if (!isCurrent()) return
            copiedTimerRef.current = null
            setCopied(false)
          }, 1600)
        } else {
          toast.success("Image downloaded")
        }
      } catch (error) {
        if (!isCurrent()) return
        toast.error(
          shareCardRenderErrorMessage(error)
          ?? (action === "copy" ? "Couldn't copy image — try Download instead" : "Couldn't generate image"),
        )
      } finally {
        if (exportOwnerRef.current.active?.id !== id) return
        exportOwnerRef.current.active = null
        if (!controller.signal.aborted) setBusy(null)
      }
    })()

    return flight.promise
  }, [messages, profilesByUserId])

  const close = useCallback(() => {
    invalidateExport()
    setBusy(null)
    setCopied(false)
    onClose()
  }, [invalidateExport, onClose])

  const copy = useCallback(() => startExport("copy"), [startExport])
  const download = useCallback(() => startExport("download"), [startExport])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {/* NOTE: DialogContent's base class carries `sm:max-w-sm` (384px). That's
          a responsive variant, so it sorts AFTER a plain `max-w-[…]` in the
          generated CSS and would silently cap the dialog at 384px — the reason a
          wider `w-*` "doesn't take effect". Override it with a matching `sm:`
          max-width so the width below can actually apply. */}
      <DialogContent className="w-180 max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>{messages.length > 1 ? `Share ${messages.length} messages` : "Share message"}</DialogTitle>
        </DialogHeader>

        {/* Preview area — the padding frames the card; the card itself is what
            gets captured. Scrolls when the card is tall (many messages, Alli
            #137): only the PREVIEW is height-bounded + scrollable — `toBlob`
            captures `cardRef` (the full card), so the export is never cut by
            this scroll bound. */}
        <div className="max-h-[60vh] overflow-y-auto bg-muted/40 px-6 py-6">
          {/* The card takes the full preview width — a generous, poster-like
              default so the share image reads as a proper card at any content
              length. The CARD itself is NOT height-capped: the exported PNG is
              the full card (Alli #137). Runaway height is bounded PER MESSAGE
              (each body clamps at 32 lines, below), and the PREVIEW container
              (the wrapper above) scrolls — so a many-message selection is fully
              exported but doesn't blow the popup out. */}
          <div
            ref={cardRef}
            data-share-card
            className="rounded-xl bg-card p-5 shadow-(--e1)"
          >
            {messages.map((msg) => {
              const author = msg.authorId
                ? readCommunityProfile(profilesByUserId.get(msg.authorId), msg.authorId)
                : null
              const replyAuthor = msg.replyTo?.authorId
                ? readCommunityProfile(
                    profilesByUserId.get(msg.replyTo.authorId),
                    msg.replyTo.authorId,
                  )
                : null
              const visibleContent = displayReplyContent(msg.content ?? "", msg.replyTo)
              return (
                <div key={msg.id} className={msg.grouped ? "mt-0.5" : "mt-3 first:mt-0"}>
                {msg.replyTo && (
                  <div
                    data-testid={`message-share-reply-${msg.id}`}
                    className="mb-1 ml-13 flex min-w-0 max-w-[calc(100%-3.25rem)] items-center gap-2 text-[13px] text-muted-foreground"
                  >
                    <div className="h-2 w-4 shrink-0 rounded-tl-md border-l-2 border-t-2 border-border" />
                    {msg.replyTo.deleted ? (
                      <span className="italic">Original message was deleted</span>
                    ) : (
                      <>
                        <span className="shrink-0 font-medium text-foreground/80">@{replyAuthor?.name ?? msg.replyTo.authorName}</span>
                        <span className="min-w-0 truncate">{stripInlineMarkup(msg.replyTo.text)}</span>
                      </>
                    )}
                  </div>
                )}
                <div className="flex gap-3">
                  {msg.grouped
                    ? <div className="w-10 shrink-0" aria-hidden />
                    : (
                        <Avatar
                          label={author?.name ?? msg.authorName ?? "Unknown"}
                          src={author?.avatar}
                          seed={msg.authorId}
                          size={40}
                        />
                      )}
                  <div className="min-w-0 flex-1">
                    {!msg.grouped && (
                      <div
                        className="mb-0.5 text-[15px] font-semibold"
                        style={{ color: msg.color ?? "var(--foreground)" }}
                      >
                        {author?.name ?? msg.authorName}
                      </div>
                    )}
                    {/* Each body: clamp at 32 lines (Alli #137 — one number for
                        single & multi share). Two layers, same as the original
                        single-message card: `max-h` hard-bounds any structure
                        (multi-paragraph markdown escapes line-clamp alone), and
                        `line-clamp-[32]` gives a single-block message a tidy
                        ellipsis. Each body also drives its own drag-highlight
                        (per-message scope, Alli #133) via its ref in `bodyRefs`;
                        the `mark[data-hl]` styles are the soft-yellow marker
                        (rasterises cleanly under html-to-image — plain bg +
                        box-decoration-break, no mask). max-h ≈ 32 lines at the
                        body's 15px/leading-snug. */}
                    {visibleContent && (
                      <div
                        ref={(el) => { bodyRefs.current.set(msg.id, el) }}
                        onMouseUp={() => onBodyMouseUp(msg.id)}
                        className="max-h-164 overflow-hidden line-clamp-32 [&_mark[data-hl]]:rounded-xs [&_mark[data-hl]]:bg-[rgba(255,208,92,0.5)] [&_mark[data-hl]]:p-[0_1px] [&_mark[data-hl]]:[box-decoration-break:clone] [&_mark[data-hl]]:[-webkit-box-decoration-break:clone] [&_mark[data-hl]]:text-inherit"
                      >
                        <MessageBody
                          text={visibleContent}
                          perspective="neutral"
                        />
                      </div>
                    )}
                    {msg.attachments?.some((attachment) => attachment.kind === "image") && (
                      <div
                        data-testid={`message-share-images-${msg.id}`}
                        className="mt-2 flex flex-col gap-2"
                      >
                        {msg.attachments.map((attachment, index) => (
                          attachment.kind === "image" && (
                            <div
                              key={`${attachment.name}-${index}`}
                              className="w-fit max-w-full overflow-hidden rounded-lg border border-border"
                            >
                              <img
                                data-testid={tid.messageShareImage(msg.id, index)}
                                src={attachment.url}
                                alt={attachment.name}
                                width={attachment.width}
                                height={attachment.height}
                                loading="eager"
                                className="block h-auto w-auto max-h-75 max-w-full rounded-lg object-contain"
                                style={{ aspectRatio: attachmentAspectRatio(attachment.width, attachment.height) }}
                              />
                            </div>
                          )
                        ))}
                      </div>
                    )}
                    {msg.reactions && msg.reactions.length > 0 && (
                      <div
                        data-testid={`message-share-reactions-${msg.id}`}
                        className="mt-2 flex flex-wrap gap-1"
                      >
                        {msg.reactions.map((reaction) => (
                          <span
                            key={reaction.emoji}
                            className={[
                              "flex h-6 items-center gap-1 rounded-md px-2 text-sm",
                              reaction.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                            ].join(" ")}
                          >
                            <span>{reaction.emoji}</span>
                            <span className="text-xs text-muted-foreground">{reaction.count}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                </div>
              )
            })}

            {/* Brand footer — Alook logo + brand font, mirrors the marketing
                footer treatment. One footer for the whole card, single or multi. */}
            <div className="mt-4 flex items-center gap-1.5 border-t border-border/50 pt-3">
              <Image src="/alook.svg" alt="" width={16} height={16} />
              <span
                className="text-sm font-bold tracking-tight text-muted-foreground"
                style={{ fontFamily: "var(--font-brand)" }}
              >
                Alook
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 pt-3 pb-5">
          {/* Left slot: Reset highlight — MOUNTED only when a highlight exists
              (Gus uiux #95: appears when useful, not a disabled ghost). Empty
              slot otherwise keeps Download/Copy right-aligned. */}
          <div>
            {highlighted && (
              <Button variant="ghost" size="sm" onClick={resetHighlights} disabled={busy !== null}>
                <Highlighter />
                Reset highlight
              </Button>
            )}
          </div>
          <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={download} disabled={busy !== null}>
            {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
          <Button
            size="sm"
            data-testid={tid.messageShareCopy}
            onClick={copy}
            disabled={busy !== null}
          >
            {busy === "copy" ? <Loader2 className="animate-spin" /> : copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy image"}
          </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
