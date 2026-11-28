"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { preconnect } from "react-dom"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import {
  AlertCircle,
  File,
  FileText,
  Loader2,
  Lock,
  Maximize,
  MessageSquare,
  Minimize,
  Presentation,
  RefreshCw,
  Shield,
  XIcon,
} from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { SheetResizeHandle, useSheetResize } from "@/components/ui/sheet-resize-handle"
import { Textarea } from "@/components/ui/textarea"
import {
  applicationKey,
  assertApplicationOwner,
  captureApplicationOwner,
  useApplicationOwner,
} from "@/lib/application-owner"
import {
  classifyPageViewerError,
  describePageSaveState,
  describePageType,
  fetchPageViewerToken,
  submitPageComment,
  type AlookPageOpenTarget,
} from "@/lib/community/open-artifact"
import { useOpenArtifactShellBridge } from "@/hooks/community/use-open-artifact-shell-bridge"
import {
  OPEN_ARTIFACT_FRAME_ALLOW,
  OPEN_ARTIFACT_SANDBOX,
  verifyOpenArtifactEmbedUrl,
  type OpenArtifactThemeScheme,
} from "@/lib/community/open-artifact-policy"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"

const DEFAULT_ARTIFACT_SHEET_WIDTH = 760
const MIN_ARTIFACT_SHEET_WIDTH = 420

function PageHeaderIcon({ kind }: { kind: "doc" | "slides" | "other" }) {
  if (kind === "doc") return <FileText className="size-4 shrink-0" aria-hidden="true" />
  if (kind === "slides") return <Presentation className="size-4 shrink-0" aria-hidden="true" />
  return <File className="size-4 shrink-0" aria-hidden="true" />
}

export function OpenArtifactSheet({
  page,
  sourceMessageId,
  open,
  onOpenChange,
}: {
  page: AlookPageOpenTarget | null
  sourceMessageId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [fullscreen, setFullscreen] = useState(false)
  const [openSession, setOpenSession] = useState<{ key: string | null; nonce: number }>({
    key: null,
    nonce: 0,
  })
  const currentPageId = open ? page?.id ?? null : null
  const resolvedSourceMessageId = open ? (sourceMessageId ?? page?.sourceMessageId)?.trim() || undefined : undefined
  const activeKey = currentPageId ? `${currentPageId}:${resolvedSourceMessageId ?? ""}` : null
  if (activeKey !== openSession.key) {
    setOpenSession({ key: activeKey, nonce: openSession.nonce + 1 })
  }
  const [closeGuard, setCloseGuard] = useState<{
    sessionKey: string | null
    leaveLosesWork: boolean
    confirmClose: boolean
  }>({
    sessionKey: null,
    leaveLosesWork: false,
    confirmClose: false,
  })

  const leaveLosesWork = closeGuard.sessionKey === activeKey && closeGuard.leaveLosesWork
  const confirmClose = closeGuard.sessionKey === activeKey && closeGuard.confirmClose

  const setLeaveLosesWork = useCallback((value: boolean) => {
    setCloseGuard((current) => ({
      sessionKey: activeKey,
      leaveLosesWork: value,
      confirmClose: value && current.sessionKey === activeKey ? current.confirmClose : false,
    }))
  }, [activeKey])

  const handleCloseConfirmed = useCallback(() => {
    setCloseGuard({ sessionKey: null, leaveLosesWork: false, confirmClose: false })
    setFullscreen(false)
    onOpenChange(false)
  }, [onOpenChange])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true)
      return
    }
    if (leaveLosesWork) {
      setCloseGuard({ sessionKey: activeKey, leaveLosesWork: true, confirmClose: true })
      return
    }
    handleCloseConfirmed()
  }, [activeKey, handleCloseConfirmed, leaveLosesWork, onOpenChange])

  const pageKey = activeKey ? `${activeKey}:${openSession.nonce}` : "none"

  return (
    <Sheet open={open} onOpenChange={handleOpenChange} modal>
      <OpenArtifactSheetSurface
        key={pageKey}
        openNonce={openSession.nonce}
        page={page}
        sourceMessageId={resolvedSourceMessageId}
        open={open}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((current) => !current)}
        confirmClose={confirmClose}
        onCancelClose={() => setCloseGuard((current) => (
          current.sessionKey === activeKey ? { ...current, confirmClose: false } : current
        ))}
        onConfirmClose={handleCloseConfirmed}
        onRequestClose={() => handleOpenChange(false)}
        onLeaveLosesWorkChange={setLeaveLosesWork}
      />
    </Sheet>
  )
}

function OpenArtifactSheetSurface({
  openNonce,
  page,
  sourceMessageId,
  open,
  fullscreen,
  onToggleFullscreen,
  confirmClose,
  onCancelClose,
  onConfirmClose,
  onRequestClose,
  onLeaveLosesWorkChange,
}: {
  openNonce: number
  page: AlookPageOpenTarget | null
  sourceMessageId?: string
  open: boolean
  fullscreen: boolean
  onToggleFullscreen: () => void
  confirmClose: boolean
  onCancelClose: () => void
  onConfirmClose: () => void
  onRequestClose: () => void
  onLeaveLosesWorkChange: (value: boolean) => void
}) {
  const owner = useApplicationOwner()
  const { resolvedTheme } = useTheme()
  const resize = useSheetResize({
    defaultWidth: DEFAULT_ARTIFACT_SHEET_WIDTH,
    minWidth: MIN_ARTIFACT_SHEET_WIDTH,
  })
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState("")
  const [commentError, setCommentError] = useState<string | null>(null)
  const [commentPending, setCommentPending] = useState(false)

  const themeScheme: OpenArtifactThemeScheme = resolvedTheme === "dark" ? "dark" : "light"
  const typeInfo = describePageType(page?.type ?? "page")

  // One-time viewer tickets must never auto-refetch on window focus or reconnect,
  // which would replace the iframe URL and discard in-progress edits. A fresh ticket
  // is fetched only on a new open session (openNonce) or explicit Retry.
  const tokenQuery = useQuery({
    queryKey: applicationKey(
      owner,
      "open-artifact-viewer-token",
      open ? page?.id ?? null : null,
      open ? sourceMessageId ?? null : null,
      openNonce,
    ),
    enabled: open && page !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    queryFn: async ({ signal }) => {
      const token = captureApplicationOwner(owner)
      const assert = () => assertApplicationOwner(token, signal)
      assert()
      if (!page) throw new Error("No page selected")
      try {
        const result = await fetchPageViewerToken(page.id, { signal, sourceMessageId })
        assert()
        return result
      } catch (error) {
        assert()
        throw error
      }
    },
  }, owner.queryClient)

  const verifiedEmbed = useMemo(() => {
    if (!tokenQuery.data) return null
    return verifyOpenArtifactEmbedUrl(tokenQuery.data.embedUrl, tokenQuery.data.allowedOrigins)
  }, [tokenQuery.data])

  const verifiedOrigin = verifiedEmbed?.ok ? verifiedEmbed.origin : null
  const verifiedUrl = verifiedEmbed?.ok ? verifiedEmbed.url : null
  if (verifiedOrigin) {
    preconnect(verifiedOrigin)
  }
  const errorInfo = tokenQuery.isError ? classifyPageViewerError(tokenQuery.error) : null

  const { shellReady, placeHash, savedState } = useOpenArtifactShellBridge({
    frameRef,
    open,
    verifiedOrigin,
    themeScheme,
    onConfirmClose,
    onLeaveLosesWorkChange,
  })

  const submitCommentText = useCallback(async (rawText: string) => {
    if (!page) return false
    const trimmed = rawText.trim()
    if (!trimmed) return false
    setCommentPending(true)
    setCommentError(null)
    try {
      await submitPageComment(page.id, {
        text: trimmed,
        location: placeHash ?? undefined,
        sourceMessageId,
      })
      toast("Comment posted to conversation")
      return true
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "Could not post comment"
      setCommentError(message)
      toast.error(message)
      return false
    } finally {
      setCommentPending(false)
    }
  }, [page, placeHash, sourceMessageId])

  const saveLabel = describePageSaveState(savedState)
  const canComment = Boolean(page && verifiedUrl && savedState !== "readonly")

  const handleCommentSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const ok = await submitCommentText(commentText)
    if (ok) {
      setCommentText("")
      setCommentOpen(false)
    }
  }

  return (
    <SheetContent
      data-testid={tid.openArtifactSheet}
      data-fullscreen={fullscreen ? "true" : "false"}
      side="right"
      showOverlay
      showCloseButton={false}
      style={{
        "--open-artifact-width": `${resize.width}px`,
        "--open-artifact-max-width": "85vw",
        maxWidth: "none",
      } as React.CSSProperties}
      className={cn(
        "data-[side=right]:h-full data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:overflow-hidden",
        fullscreen
          ? "data-[side=right]:sm:inset-2 data-[side=right]:sm:left-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:w-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
          : "data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:w-[clamp(26.25rem,var(--open-artifact-width),min(var(--open-artifact-max-width),calc(var(--app-safe-width)-1rem)))] data-[side=right]:sm:rounded-xl data-[side=right]:sm:border",
      )}
    >
      {!fullscreen && <SheetResizeHandle {...resize} />}

      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/70 text-foreground/80">
            <PageHeaderIcon kind={typeInfo.kind} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SheetTitle className="truncate text-sm font-medium sm:text-base">
              {page?.title ?? "Page"}
            </SheetTitle>
            <SheetDescription className="flex items-center gap-2 truncate text-xs text-muted-foreground">
              <span>{typeInfo.label}</span>
              {saveLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    data-testid={tid.openArtifactStatus}
                    className={cn(
                      "inline-flex items-center gap-1",
                      savedState === "unsaved" && "text-warning",
                    )}
                  >
                    {savedState === "unsaved" && <AlertCircle className="size-3 shrink-0" aria-hidden="true" />}
                    {savedState === "readonly" && <Lock className="size-3 shrink-0" aria-hidden="true" />}
                    <span>{saveLabel}</span>
                  </span>
                </>
              )}
            </SheetDescription>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canComment && (
            <Popover open={commentOpen} onOpenChange={setCommentOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={tid.openArtifactCommentTrigger}
                    className="h-11 gap-1.5 px-2.5 text-xs font-medium sm:h-8"
                  />
                }
              >
                <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Comment</span>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-3">
                <form onSubmit={(event) => void handleCommentSubmit(event)} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Comment to conversation
                    </span>
                    {placeHash && (
                      <span className="max-w-36 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {placeHash}
                      </span>
                    )}
                  </div>
                  <Textarea
                    data-testid={tid.openArtifactCommentInput}
                    value={commentText}
                    onChange={(event) => {
                      setCommentText(event.target.value)
                      if (commentError) setCommentError(null)
                    }}
                    placeholder="Ask the bot to update this page or share feedback…"
                    rows={3}
                    className="min-h-20 resize-none text-sm"
                  />
                  {commentError && (
                    <p role="alert" className="text-xs text-destructive">
                      {commentError}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setCommentOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      data-testid={tid.openArtifactCommentSubmit}
                      disabled={commentPending || commentText.trim().length === 0}
                    >
                      {commentPending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                </form>
              </PopoverContent>
            </Popover>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid={tid.openArtifactFullscreen}
            aria-label={fullscreen ? "Exit full screen" : "Expand to full screen"}
            aria-pressed={fullscreen}
            onClick={onToggleFullscreen}
            className="hidden size-8 sm:inline-flex"
          >
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close page"
            onClick={onRequestClose}
            className="size-11 sm:size-8"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      {confirmClose && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs sm:px-5"
        >
          <span className="flex items-center gap-2 text-foreground">
            <AlertCircle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>Unsaved changes may be lost if you close now.</span>
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancelClose}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onConfirmClose}>
              Close anyway
            </Button>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {tokenQuery.isPending && (
          <div
            role="status"
            data-testid={tid.openArtifactStatus}
            className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground"
          >
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>Opening {typeInfo.label}…</span>
          </div>
        )}

        {errorInfo && (
          <div
            role="alert"
            data-testid={errorInfo.kind === "revoked" ? tid.openArtifactRevoked : tid.openArtifactStatus}
            className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground">
                {errorInfo.kind === "revoked" || errorInfo.kind === "unauthenticated"
                  ? <Lock className="size-7" aria-hidden="true" />
                  : <AlertCircle className="size-7" aria-hidden="true" />}
              </div>
              <p className="max-w-65 text-sm font-medium text-foreground">{errorInfo.title}</p>
              <p className="-mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">{errorInfo.description}</p>
            </div>
            <div className="flex items-center gap-2">
              {errorInfo.retryable && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={tid.openArtifactRetry}
                  onClick={() => { void tokenQuery.refetch() }}
                  className="min-h-11 gap-1.5 sm:min-h-8"
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  <span>Retry</span>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onConfirmClose}
                className="min-h-11 sm:min-h-8"
              >
                Close
              </Button>
            </div>
          </div>
        )}

        {verifiedEmbed && !verifiedEmbed.ok && (
          <div
            role="alert"
            data-testid={tid.openArtifactStatus}
            className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground">
                <Shield className="size-7" aria-hidden="true" />
              </div>
              <p className="max-w-65 text-sm font-medium text-foreground">Blocked untrusted page</p>
              <p className="-mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                This page address is not from an allowed Alook Page host.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onConfirmClose}
              className="min-h-11 sm:min-h-8"
            >
              Close
            </Button>
          </div>
        )}

        {verifiedUrl && page && (
          <>
            {!frameLoaded && !shellReady && (
              <div
                role="status"
                className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/80 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>Loading {typeInfo.label}…</span>
              </div>
            )}
            <iframe
              ref={frameRef}
              title={page.title}
              data-testid={tid.openArtifactFrame}
              src={verifiedUrl}
              sandbox={OPEN_ARTIFACT_SANDBOX}
              allow={OPEN_ARTIFACT_FRAME_ALLOW}
              referrerPolicy="no-referrer"
              onLoad={() => setFrameLoaded(true)}
              className="block size-full flex-1 border-0 bg-background"
            />
          </>
        )}
      </div>
    </SheetContent>
  )
}
