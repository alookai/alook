"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { saveFile, fileSaveMessage, type FileSaveResult } from "@/lib/file-save"
import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import { Check, Copy, Download, Highlighter, Loader2 } from "lucide-react"
import { writeImage } from "@tauri-apps/plugin-clipboard-manager"
import { isDesktop, isMobile, isTauri, stripInlineMarkup } from "@alook/shared"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Avatar } from "../avatar"
import { ShareImagePreparationContext } from "@/components/remote-image/share-image-context"
import { MessageBody } from "./message-body"
import { attachmentAspectRatio } from "./attachment-layout"
import { tid } from "@/lib/community/testids"
import { applyHighlightToRange, clearHighlights, hasHighlights } from "@/lib/community/highlight-range"
import { formatMessageTime } from "@/lib/community/format-time"
import type { RenderMsg } from "@/lib/community/models/message"
import { displayReplyContent } from "@/lib/community/reply-content"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
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

export async function writeShareCardToClipboard(blob: Blob, assertActive?: () => void): Promise<void> {
  assertActive?.()
  if (isTauri() && isDesktop()) {
    const bytes = await blob.arrayBuffer()
    assertActive?.()
    await writeImage(bytes)
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

async function saveShareCardDownload(blob: Blob, filename: string, save?: ShareCardBlobWriter, signal?: AbortSignal): Promise<FileSaveResult> {
  if (save) { await save(blob); return { status: "started" } }
  return saveFile(blob, filename, { signal })
}

export async function downloadRenderedShareCard(render: ShareCardRenderer, filename: string, save?: ShareCardBlobWriter): Promise<FileSaveResult> {
  const blob = await render()
  if (!blob) throw new ShareImageSessionError("rasterize")
  return saveShareCardDownload(blob, filename, save)
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
  const runtime = useCommunityRuntime(), client = useQueryClient()
  const messageIdentity = messages.map((message) => message.id).join(":")
  const scopeId = useMemo(() => ({ runtime, messageIdentity, open, id: crypto.randomUUID() }), [runtime, messageIdentity, open]).id
  const source = useCommunityViewSource(`share-image:${scopeId}`, open)
  const profileIds = useMemo(() => [...new Set(messages.flatMap((message) => [message.authorId, message.replyTo?.authorId].filter((id): id is string => !!id)))], [messages])
  const profilesByUserId = useCanonicalProfilesByUserId(profileIds)
  const previewRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useAtom(useCreateAtom(false))
  const [highlighted, setHighlighted] = useAtom(useCreateAtom(false))
  const [captureRevision, setCaptureRevision] = useAtom(useCreateAtom(0))
  const [prepareAttempt, setPrepareAttempt] = useAtom(useCreateAtom(0))
  const [preparationNode, setPreparationNode] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const preparationKey = ["community", "share-image", scopeId, "prepare", prepareAttempt] as const
  const preparation = useQuery({ queryKey: preparationKey, enabled: open && !!preparationNode, subscribed: open, staleTime: Infinity, gcTime: 0, retry: false,
    queryFn: async ({ signal }) => {
      const assert = source.capture()
      assert()
      const node = preparationNode
      if (!node) throw new ShareImageSessionError("source")
      const authorId = messages[0]?.authorId
      const author = authorId ? readCommunityProfile(profilesByUserId.get(authorId), authorId) : null
      const value = await prepareShareImageSession(node, { signal })
      assert()
      return { value, filename: `alook-message-${author?.name ?? "share"}.png` }
    },
  })
  const session: ShareSessionState = !open ? { status: "idle" } : preparation.data ? { status: "ready", ...preparation.data }
    : preparation.isError ? { status: "error", message: shareCardRenderErrorMessage(preparation.error) ?? "Couldn't prepare share image" } : { status: "preparing" }
  const pngOptions = { queryKey: ["community", "share-image", scopeId, "png", prepareAttempt, captureRevision], staleTime: Infinity, gcTime: 0, retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const assert = source.capture()
      assert()
      const prepared = client.getQueryData<{ value: PreparedShareImageSession; filename: string }>(preparationKey)
      const node = previewRef.current?.querySelector<HTMLElement>("[data-share-card]")
      if (!node || !prepared) throw new ShareImageSessionError("rasterize")
      const blob = await renderShareCard(node, prepared.value.fontEmbedCSS, toBlob, { signal })
      assert()
      return blob
    },
  }
  useQuery({ ...pngOptions, enabled: false, subscribed: open })
  const exportKey = ["community", "share-image", scopeId, "export"]
  const command = useMutation({ meta: { observabilityAction: "message.export" }, mutationKey: exportKey, gcTime: 0,
    mutationFn: async ({ action, original }: { action: "copy" | "download"; original: ReturnType<typeof source.capture> }) => {
      original()
      const prepared = client.getQueryData<{ value: PreparedShareImageSession; filename: string }>(preparationKey)
      if (!prepared) throw new ShareImageSessionError("source")
      const blob = await client.query({ ...pngOptions, select: undefined })
      original()
      if (action === "copy") {
        if (mobileNative) {
          const { copyMobileShareImage } = await import("@/lib/community/mobile-share-image")
          original()
          await copyMobileShareImage(blob, original)
        } else await writeShareCardToClipboard(blob, original)
        original()
        return { action, destination: null }
      }
      if (mobileNative) {
        const { saveMobileShareImage } = await import("@/lib/community/mobile-share-image")
        original()
        const result = await saveMobileShareImage(blob, prepared.filename, original)
        original()
        return { action, destination: result.destination }
      }
      const result = await saveShareCardDownload(blob, prepared.filename, undefined, original.signal)
      original()
      if (result.status === "error") toast.error(fileSaveMessage(result))
      else if (result.status !== "cancelled") toast.success(fileSaveMessage(result))
      return { action, destination: null }
    },
    onSuccess: (result, intent) => {
      try { intent.original() } catch { return }
      if (result.action === "copy") {
        setCopied(true)
        toast.success("Image copied to clipboard")
        copiedTimerRef.current = window.setTimeout(() => {
          try { intent.original() } catch { return }
          copiedTimerRef.current = null
          setCopied(false)
        }, 1600)
      } else if (result.destination === "photos") toast.success("Saved to Photos")
      else if (result.destination === "pictures") toast.success("Saved to Pictures/Alook")
      else if (result.destination === "document") toast.success("Image saved")
    },
    onError: (error, intent) => {
      try { intent.original() } catch { return }
      const code = mobileShareImageErrorCode(error)
      if (code === "cancelled" || (error as { name?: unknown })?.name === "AbortError") return
      if (code === "image_too_large") { toast.error("Image is too large — select fewer messages"); return }
      if (intent.action === "download" && code === "permission_denied") { toast.error("Couldn't save image — allow Photos access in Settings"); return }
      toast.error(shareCardRenderErrorMessage(error) ?? (intent.action === "copy" ? mobileNative ? "Couldn't copy image — try Save image instead" : "Couldn't copy image — try Download instead" : mobileNative ? "Couldn't save image" : "Couldn't generate image"))
    },
  })
  const busy = command.isPending ? command.variables.action : null
  const anyHighlight = useCallback(() => {
    const preview = previewRef.current
    return !!preview && [...preview.querySelectorAll<HTMLElement>("[data-share-body-id]")].some((body) => hasHighlights(body))
  }, [])
  const onPreviewMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (busy !== null) return
    source.capture()()
    const target = event.target instanceof Element ? event.target : null
    const body = target?.closest<HTMLElement>("[data-share-body-id]")
    if (!body || !previewRef.current?.contains(body)) return
    const selection = window.getSelection?.()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) return
    const added = applyHighlightToRange(body, range)
    selection.removeAllRanges()
    if (added <= 0) return
    setCaptureRevision((value) => value + 1)
    setHighlighted(anyHighlight())
  }, [anyHighlight, busy, setCaptureRevision, setHighlighted, source])
  const resetHighlights = useCallback(() => {
    source.capture()()
    const preview = previewRef.current
    if (!preview) return
    for (const body of preview.querySelectorAll<HTMLElement>("[data-share-body-id]")) clearHighlights(body)
    setCaptureRevision((value) => value + 1)
    setHighlighted(false)
  }, [setCaptureRevision, setHighlighted, source])
  useEffect(() => {
    setCopied(false)
    setHighlighted(false)
    return () => { if (copiedTimerRef.current !== null) { window.clearTimeout(copiedTimerRef.current); copiedTimerRef.current = null } }
  }, [scopeId, setCopied, setHighlighted])
  const startExport = async (action: "copy" | "download") => {
    const original = source.capture()
    original()
    if (session.status !== "ready" || client.getMutationCache().findAll({ mutationKey: exportKey, status: "pending" }).length) return
    if (copiedTimerRef.current !== null) { window.clearTimeout(copiedTimerRef.current); copiedTimerRef.current = null }
    setCopied(false)
    try { await command.mutateAsync({ action, original }) } catch {}
  }
  const close = () => { source.retire(); onClose() }
  const copy = () => startExport("copy")
  const download = () => startExport("download")

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
            <ShareImagePreparationContext value={true}>
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
                          label={author?.name ?? msg.authorName ?? "Deleted user"}
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
                                data-share-image-src={attachment.url}
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

            </ShareImagePreparationContext>
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
