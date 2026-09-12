"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import { Check, Copy, Download, Highlighter, Loader2 } from "lucide-react"
import { writeImage } from "@tauri-apps/plugin-clipboard-manager"
import { isDesktop, isMobile, isTauri, stripInlineMarkup } from "@alook/shared"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import { MessageBody } from "./message-body"
import { attachmentAspectRatio } from "./attachment-layout"
import { tid } from "@/lib/community/testids"
import { applyHighlightToRange, clearHighlights, hasHighlights } from "@/lib/community/highlight-range"
import { formatMessageTime } from "@/lib/community/format-time"
import type { RenderMsg } from "@/lib/community/models/message"
import { displayReplyContent } from "@/lib/community/reply-content"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { AnimatedAlookLogo } from "@/components/community/shell/animated-alook-logo"
import {
  capturePreparedShareImage,
  prepareShareImageSession,
  ShareImageSessionError,
  type PreparedShareImageSession,
} from "@/lib/community/share-image-session"

export { ShareImageSessionError as ShareCardRenderError }

async function renderShareCard(
  node: HTMLElement,
  fontEmbedCSS = "",
  rasterize = toBlob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  return capturePreparedShareImage(node, fontEmbedCSS, rasterize, options)
}

type ShareCardRenderer = () => Promise<Blob | null>
type ShareCardBlobWriter = (blob: Blob) => Promise<void> | void

function mobileShareImageErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const value = error as { name?: unknown; code?: unknown }
  return value.name === "MobileShareImageError" && typeof value.code === "string"
    ? value.code
    : null
}

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
  if (!blob) throw new ShareImageSessionError("rasterize")
  await write(blob)
}

async function saveShareCardDownload(
  blob: Blob,
  filename: string,
  save: ShareCardBlobWriter = (value) => {
    const url = URL.createObjectURL(value)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
    queueMicrotask(() => URL.revokeObjectURL(url))
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
  if (!blob) throw new ShareImageSessionError("rasterize")
  await saveShareCardDownload(blob, filename, save)
}

export function shareCardRenderErrorMessage(error: unknown): string | null {
  if (!(error instanceof ShareImageSessionError)) return null
  const stage = {
    source: "preparing the preview",
    assets: "preparing images",
    fonts: "loading fonts",
    freeze: "freezing the preview",
    rasterize: "rendering the image",
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

type ShareSessionState =
  | { status: "idle" | "preparing" }
  | { status: "ready"; value: PreparedShareImageSession; filename: string }
  | { status: "error"; message: string }

export function MessageShareDialog({ m, open, onClose }: {
  m: RenderMsg | RenderMsg[]
  open: boolean
  onClose: () => void
}) {
  const messages = useMemo(() => (Array.isArray(m) ? m : [m]), [m])
  const mobileNative = isTauri() && isMobile()
  const profilesByUserId = useProfilesByUserId()
  const profilesByUserIdRef = useRef(profilesByUserId)
  const messagesRef = useRef(messages)
  const previewRef = useRef<HTMLDivElement>(null)
  const exportOwnerRef = useRef<{
    generation: number
    active: ShareCardExportFlight | null
  }>({ generation: 0, active: null })
  const copiedTimerRef = useRef<number | null>(null)
  const pngRef = useRef<{
    revision: number
    promise: Promise<Blob>
  } | null>(null)
  const [busy, setBusy] = useState<"copy" | "download" | null>(null)
  const [copied, setCopied] = useState(false)
  const [highlighted, setHighlighted] = useState(false)
  const [captureRevision, setCaptureRevision] = useState(0)
  const [prepareAttempt, setPrepareAttempt] = useState(0)
  const [preparationNode, setPreparationNode] = useState<HTMLDivElement | null>(null)
  const [session, setSession] = useState<ShareSessionState>({ status: "idle" })

  useEffect(() => {
    profilesByUserIdRef.current = profilesByUserId
  }, [profilesByUserId])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const anyHighlight = useCallback(() => {
    const preview = previewRef.current
    return !!preview && [...preview.querySelectorAll<HTMLElement>("[data-share-body-id]")]
      .some((body) => hasHighlights(body))
  }, [])

  const onPreviewMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (busy !== null) return
    const target = event.target instanceof Element ? event.target : null
    const body = target?.closest<HTMLElement>("[data-share-body-id]")
    if (!body || !previewRef.current?.contains(body)) return
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) return
    const added = applyHighlightToRange(body, range)
    sel.removeAllRanges()
    if (added <= 0) return
    pngRef.current = null
    setCaptureRevision((value) => value + 1)
    setHighlighted(anyHighlight())
  }, [anyHighlight, busy])

  const resetHighlights = useCallback(() => {
    const preview = previewRef.current
    if (!preview) return
    for (const body of preview.querySelectorAll<HTMLElement>("[data-share-body-id]")) {
      clearHighlights(body)
    }
    pngRef.current = null
    setCaptureRevision((value) => value + 1)
    setHighlighted(false)
  }, [])

  const invalidateExport = useCallback(() => {
    const owner = exportOwnerRef.current
    owner.generation += 1
    owner.active?.controller.abort()
    owner.active = null
    pngRef.current = null
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (open) return
    invalidateExport()
    setBusy(null)
    setCopied(false)
    setSession({ status: "idle" })
    setHighlighted(false)
  }, [invalidateExport, open])

  useEffect(() => () => invalidateExport(), [invalidateExport])

  useEffect(() => {
    if (!open) return
    const source = preparationNode
    if (!source) return
    const controller = new AbortController()
    const firstAuthorId = messagesRef.current[0]?.authorId
    const firstAuthor = firstAuthorId
      ? readCommunityProfile(profilesByUserIdRef.current.get(firstAuthorId), firstAuthorId)
      : null
    const filename = `alook-message-${firstAuthor?.name ?? "share"}.png`
    setSession({ status: "preparing" })
    setHighlighted(false)
    pngRef.current = null
    void prepareShareImageSession(source, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return
        setSession({ status: "ready", value, filename })
      },
      (error) => {
        if (controller.signal.aborted || (error as { name?: unknown })?.name === "AbortError") return
        setSession({
          status: "error",
          message: shareCardRenderErrorMessage(error) ?? "Couldn't prepare share image",
        })
      },
    )
    return () => controller.abort()
  }, [open, preparationNode, prepareAttempt])

  const startExport = useCallback((action: "copy" | "download"): Promise<void> => {
    const owner = exportOwnerRef.current
    if (owner.active) return owner.active.promise
    if (session.status !== "ready") return Promise.resolve()

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

    const filename = session.filename
    const isCurrent = () => (
      exportOwnerRef.current.generation === id && !controller.signal.aborted
    )

    flight.promise = (async () => {
      try {
        const node = previewRef.current?.querySelector<HTMLElement>("[data-share-card]")
        if (!node) throw new ShareImageSessionError("rasterize")
        let rendered = pngRef.current
        if (!rendered || rendered.revision !== captureRevision) {
          const promise = renderShareCard(node, session.value.fontEmbedCSS, toBlob, {
            signal: controller.signal,
          })
          rendered = { revision: captureRevision, promise }
          pngRef.current = rendered
          promise.catch(() => {
            if (pngRef.current?.promise === promise) pngRef.current = null
          })
        }
        const blob = await rendered.promise
        if (!isCurrent()) return

        let mobileDestination: "photos" | "pictures" | "document" | null = null
        if (action === "copy") {
          if (mobileNative) {
            const { copyMobileShareImage } = await import("@/lib/community/mobile-share-image")
            if (!isCurrent()) return
            await copyMobileShareImage(blob)
          } else await writeShareCardToClipboard(blob)
        } else if (mobileNative) {
          const { saveMobileShareImage } = await import("@/lib/community/mobile-share-image")
          if (!isCurrent()) return
          mobileDestination = (await saveMobileShareImage(blob, filename)).destination
        } else await saveShareCardDownload(blob, filename)
        if (!isCurrent()) return

        if (action === "copy") {
          setCopied(true)
          toast.success("Image copied to clipboard")
          copiedTimerRef.current = window.setTimeout(() => {
            if (!isCurrent()) return
            copiedTimerRef.current = null
            setCopied(false)
          }, 1600)
        } else if (mobileDestination === "photos") {
          toast.success("Saved to Photos")
        } else if (mobileDestination === "pictures") {
          toast.success("Saved to Pictures/Alook")
        } else if (mobileDestination === "document") {
          toast.success("Image saved")
        } else {
          toast.success("Image downloaded")
        }
      } catch (error) {
        if (!isCurrent()) return
        const mobileErrorCode = mobileShareImageErrorCode(error)
        if (mobileErrorCode === "cancelled") return
        if (mobileErrorCode === "image_too_large") {
          toast.error("Image is too large — select fewer messages")
          return
        }
        if (
          action === "download"
          && mobileErrorCode === "permission_denied"
        ) {
          toast.error("Couldn't save image — allow Photos access in Settings")
          return
        }
        toast.error(
          shareCardRenderErrorMessage(error)
          ?? (action === "copy"
            ? mobileNative
              ? "Couldn't copy image — try Save image instead"
              : "Couldn't copy image — try Download instead"
            : mobileNative ? "Couldn't save image" : "Couldn't generate image"),
        )
      } finally {
        if (exportOwnerRef.current.active?.id !== id) return
        exportOwnerRef.current.active = null
        if (!controller.signal.aborted) setBusy(null)
      }
    })()

    return flight.promise
  }, [captureRevision, mobileNative, session])

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

        <div className="thin-scrollbar max-h-[60vh] overflow-y-auto bg-muted/40 px-6 py-6">
          {session.status === "ready" ? (
            <div
              ref={previewRef}
              onMouseUp={onPreviewMouseUp}
              dangerouslySetInnerHTML={{ __html: session.value.markup }}
            />
          ) : (
            <div
              data-share-session-state={session.status}
              className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl bg-card p-5 text-sm text-muted-foreground shadow-(--e1)"
            >
              {session.status === "error" ? (
                <>
                  <span>{session.message}</span>
                  <Button size="sm" variant="outline" onClick={() => setPrepareAttempt((value) => value + 1)}>
                    Retry
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 className="animate-spin" />
                  <span>Preparing share image…</span>
                </>
              )}
            </div>
          )}
          {open && session.status !== "ready" && (
            <div
              aria-hidden
              className="pointer-events-none fixed left-[-10000px] top-0 w-[calc(100vw-5rem)] max-w-2xl opacity-0"
            >
              <div
                ref={setPreparationNode}
                data-share-card-source
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
                      <div data-share-identity-id={msg.authorId} className="size-10 shrink-0">
                        <Avatar
                          label={author?.name ?? msg.authorName ?? "Unknown"}
                          src={author?.avatar}
                          seed={msg.authorId}
                          size={40}
                        />
                      </div>
                      )}
                  <div className="min-w-0 flex-1">
                    {!msg.grouped && (
                      <div
                        className="mb-0.5 flex items-baseline gap-2"
                      >
                        <span
                          className="min-w-0 max-w-full truncate text-[15px] font-semibold"
                          style={{ color: msg.color ?? "var(--foreground)" }}
                        >
                          {author?.name ?? msg.authorName}
                        </span>
                        <span
                          data-share-timestamp
                          className="shrink-0 text-xs text-muted-foreground"
                          suppressHydrationWarning
                        >
                          {formatMessageTime(msg.createdAt)}
                        </span>
                      </div>
                    )}
                    {visibleContent && (
                      <div
                        data-share-body-id={msg.id}
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

            <div className="mt-4 flex items-center gap-1.5 border-t border-border/50 pt-3">
              <AnimatedAlookLogo className="size-4" />
              <span
                data-share-brand
                data-share-brand-font="caveat"
                className="text-sm font-bold tracking-tight text-muted-foreground"
                style={{ fontFamily: "var(--font-brand)" }}
              >
                Alook
              </span>
            </div>
              </div>
            </div>
          )}
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
            <Button
              variant="ghost"
              size="sm"
              data-testid={mobileNative ? tid.messageShareSave : undefined}
              onClick={download}
              disabled={busy !== null || session.status !== "ready"}
            >
              {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
              {mobileNative ? "Save image" : "Download"}
            </Button>
            <Button
              size="sm"
              data-testid={tid.messageShareCopy}
              onClick={copy}
              disabled={busy !== null || session.status !== "ready"}
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
