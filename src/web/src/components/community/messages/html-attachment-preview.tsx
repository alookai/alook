"use client"

import { useQuery } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useEffect, useMemo, useRef, useState } from "react"
import { LoaderCircle } from "@/components/icons/lucide";
import { useTheme } from "next-themes"
import { collectHtmlPreviewFonts, loadHtmlPreviewFonts } from "@/lib/community/html-preview-fonts"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, useApplicationOwner } from "@/lib/application-owner"
import { HTML_PREVIEW_SANDBOX, HTML_PREVIEW_THEME_VARIABLES } from "@/lib/community/html-preview-policy"
import { useHtmlPreviewHeight } from "@/hooks/community/use-html-preview-height"
import { useHtmlPreviewViewport } from "@/hooks/community/use-html-preview-viewport"
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
  const [mounted, setMounted] = useState<boolean>(() => typeof window !== "undefined" && !window.IntersectionObserver)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const id = attachment.id
  const { height: naturalHeight, recordHeight } = useHtmlPreviewHeight(owner, id, attachment.url)
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
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const {
    attachRoot,
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
  const url = `${attachment.url}?preview=html&v=${encodeURIComponent(process.env.NEXT_PUBLIC_APP_VERSION ?? "")}`
  const error = status === "error"

  useEffect(() => {
    const element = root.current
    if (mounted || !element || !window.IntersectionObserver) return
    const scrollRoot =
      element.closest<HTMLElement>("[data-slot='scroll-area-viewport']")
      ?? element.closest("[data-message-list-content]")?.parentElement
      ?? null
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setMounted(true); observer.disconnect() }
    }, { root: scrollRoot, rootMargin: "200px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [mounted])

  useEffect(() => {
    if (!mounted || error) return
    function theme() {
      // Read tokens where the preview is shown: the app theme sets them on
      // <body>, so <html> alone would hand the frame the unthemed palette.
      const style = getComputedStyle(frame.current ?? document.documentElement)
      const variables = Object.fromEntries(HTML_PREVIEW_THEME_VARIABLES.map((key) => [`--${key}`, style.getPropertyValue(`--${key}`).trim()]))
      variables["--font-sans"] = style.getPropertyValue("--font-dm-sans").trim() || style.fontFamily
      variables["--font-mono"] = style.getPropertyValue("--font-dm-mono").trim() || "ui-monospace, monospace"
      frame.current?.contentWindow?.postMessage({ type: "alook-html-theme", dark: resolvedTheme === "dark", variables, fontSheet }, "*")
    }
    const timeout = setTimeout(() => { if (!ready.current) setStatus("error") }, 15_000)
    function message(event: MessageEvent<unknown>) {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || event.origin !== "null"
        || typeof event.data !== "object" || event.data === null || !("type" in event.data)) return
      if (event.data.type === "alook-html-theme-request") theme()
      if (event.data.type === "alook-html-ready") {
        clearTimeout(timeout)
        ready.current = true
        setStatus("ready")
        theme()
      }
      if (event.data.type === "alook-html-height" && "height" in event.data
        && typeof event.data.height === "number" && Number.isFinite(event.data.height) && event.data.height > 0) {
        recordHeight(event.data.height)
      }
      if (
        event.data.type === "alook-html-scroll"
        && "scrollTop" in event.data
        && "scrollHeight" in event.data
        && "clientHeight" in event.data
        && typeof event.data.scrollTop === "number"
        && typeof event.data.scrollHeight === "number"
        && typeof event.data.clientHeight === "number"
        && Number.isFinite(event.data.scrollTop)
        && Number.isFinite(event.data.scrollHeight)
        && Number.isFinite(event.data.clientHeight)
      ) {
        reportScrollMetrics({
          scrollTop: event.data.scrollTop,
          scrollHeight: event.data.scrollHeight,
          clientHeight: event.data.clientHeight,
        })
      }
    }
    window.addEventListener("message", message)
    theme()
    const themeFrame = requestAnimationFrame(theme)
    return () => { clearTimeout(timeout); cancelAnimationFrame(themeFrame); window.removeEventListener("message", message) }
  }, [mounted, error, resolvedTheme, fontSheet, recordHeight, reportScrollMetrics])

  if (error) return null

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
      {mounted && <iframe
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
