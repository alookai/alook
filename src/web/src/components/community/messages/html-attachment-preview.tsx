"use client"

import { useQuery } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useMemo, useRef } from "react"
import { LoaderCircle } from "@/components/icons/lucide";
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { collectHtmlPreviewFonts, loadHtmlPreviewFonts } from "@/lib/community/html-preview-fonts"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, useApplicationOwner } from "@/lib/application-owner"
import { HTML_PREVIEW_SANDBOX } from "@/lib/community/html-preview-policy"
import { useHtmlPreviewHeight } from "@/hooks/community/use-html-preview-height"
import { useHtmlPreviewBridge, useHtmlPreviewViewport, useHtmlPreviewVisibility } from "@/hooks/community/use-html-preview-viewport"
import type { FileAttachment } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"

export function HtmlAttachmentPreview({ attachment }: { attachment: FileAttachment & { id: string } }) {
  const owner = useApplicationOwner()
  const lifecycle = useSelector(owner.lifecycle)
  return lifecycle.active ? <HtmlPreviewDocument key={`${owner.userId}:${lifecycle.generation}:${attachment.id}:${attachment.url}`} attachment={attachment} /> : null
}

function HtmlPreviewDocument({ attachment }: { attachment: FileAttachment & { id: string } }) {
  const owner = useApplicationOwner()
  const { resolvedTheme } = useTheme()
  const fonts = useMemo(() => typeof document === "undefined" ? [] : collectHtmlPreviewFonts(document,
    getComputedStyle(document.documentElement).getPropertyValue("--font-dm-sans") + "," + getComputedStyle(document.documentElement).getPropertyValue("--font-dm-mono")), [])
  const id = attachment.id
  const { height: naturalHeight, recordHeight } = useHtmlPreviewHeight(owner, id, attachment.url)
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const {
    attachRoot,
    container,
    renderedHeight,
    canScroll,
    scrollFade,
    maskImage,
    dragging,
    scrollbarVisible,
    thumbHeight,
    thumbOffset,
    reportScrollMetrics,
    handleRootPointerEnter,
    handleRootPointerMove,
    handleRootPointerLeave,
    handleTrackPointerDown,
    handleThumbPointerDown,
  } = useHtmlPreviewViewport({ rootRef: root, frameRef: frame, naturalHeight })
  const mounted = useHtmlPreviewVisibility({ rootRef: root, container })
  const fontSheet = useQuery({
    queryKey: applicationKey(owner, "html-preview-fonts", fonts), enabled: mounted && fonts.length > 0,
    staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const token = captureApplicationOwner(owner)
      assertApplicationOwner(token, signal)
      const css = await loadHtmlPreviewFonts(fonts, signal)
      assertApplicationOwner(token, signal)
      return css
    },
  }, owner.queryClient).data
  const { attempt, loaded, setLoaded, status, error, retry } = useHtmlPreviewBridge({
    mounted,
    frameRef: frame,
    resolvedTheme,
    fontSheet,
    recordHeight,
    reportScrollMetrics,
  })
  const url = `${attachment.url}?preview=html&v=${encodeURIComponent(process.env.NEXT_PUBLIC_APP_VERSION ?? "")}`

  const showOverlayScrollbar = status === "ready" && canScroll
  const appliedScrollFade = status === "ready" ? scrollFade : "none"
  const appliedMaskImage = status === "ready" ? maskImage : undefined

  return (
    <div
      ref={attachRoot}
      role="group"
      aria-label={attachment.name}
      data-html-preview
      data-testid={tid.htmlPreview(id)}
      data-html-preview-status={status}
      onPointerEnter={handleRootPointerEnter}
      onPointerMove={handleRootPointerMove}
      onPointerLeave={handleRootPointerLeave}
      className="relative m-0 block w-full min-w-0 max-w-full overflow-hidden rounded-none border-0 bg-transparent p-0 text-foreground"
      style={!mounted ? { height: renderedHeight } : undefined}
    >
      {status === "loading" && <div role="status" aria-label="Loading preview" className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      </div>}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          <span>Preview didn&apos;t finish loading.</span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {mounted && !error && <iframe
        key={attempt}
        ref={frame}
        title={attachment.name}
        data-testid={tid.htmlPreviewFrame(id)}
        data-scroll-fade={appliedScrollFade}
        src={url}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        onLoad={() => setLoaded(true)}
        className="block w-full border-0 bg-transparent scheme-light"
        style={{
          height: renderedHeight,
          colorScheme: loaded ? resolvedTheme === "dark" ? "dark" : "light" : undefined,
          maskImage: appliedMaskImage,
          WebkitMaskImage: appliedMaskImage,
          pointerEvents: dragging ? "none" : undefined,
        }}
      />}
      {showOverlayScrollbar && (
        <div
          aria-hidden="true"
          data-slot="html-preview-scrollbar"
          data-visible={scrollbarVisible ? "true" : "false"}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={handleTrackPointerDown}
          className={cn(
            "absolute inset-y-0 right-0 z-20 flex w-2.5 touch-none select-none flex-col p-0.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
            scrollbarVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div
            data-slot="html-preview-scrollbar-thumb"
            onPointerDown={handleThumbPointerDown}
            className="w-full shrink-0 rounded-full bg-foreground/20 transition-colors duration-150 ease-out hover:bg-foreground/35 active:bg-foreground/45 motion-reduce:transition-none"
            style={{
              height: thumbHeight,
              transform: `translate3d(0,${thumbOffset}px,0)`,
            }}
          />
        </div>
      )}
    </div>
  )
}
