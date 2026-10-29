"use client"

import { useQuery } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useEffect, useMemo, useRef, useState } from "react"
import { Download, Expand, LoaderCircle, X } from "lucide-react"
import { useTheme } from "next-themes"
import { collectHtmlPreviewFonts, loadHtmlPreviewFonts } from "@/lib/community/html-preview-fonts"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, useApplicationOwner } from "@/lib/application-owner"
import { HTML_PREVIEW_SANDBOX, HTML_PREVIEW_THEME_VARIABLES } from "@/lib/community/html-preview-policy"
import type { FileAttachment } from "@/lib/community/models/message"
import { useAttachmentDownload, attachmentDownloadStatusText } from "@/lib/community/attachment-download"
import { tid } from "@/lib/community/testids"
import { buttonVariants } from "@/components/ui/button"
import { useNativeBackOwner } from "@/components/ui/native-back-layer"
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
  const [mounted, setMounted] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [height, setHeight] = useState(320)
  const [expanded, setExpanded] = useState(false)
  const [inlineHeight, setInlineHeight] = useState(0)
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
  const root = useRef<HTMLDialogElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const expandButton = useRef<HTMLButtonElement>(null)
  const download = useAttachmentDownload(attachment)
  const id = attachment.id
  const url = `${attachment.url}?preview=html`
  const error = status === "error"

  useEffect(() => {
    const element = root.current
    if (!element) return
    if (!window.IntersectionObserver) { setMounted(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setMounted(true); observer.disconnect() }
    }, { rootMargin: "200px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!mounted || error) return
    function theme() {
      const style = getComputedStyle(document.documentElement)
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
        setHeight(Math.max(80, Math.min(2000, Math.ceil(event.data.height))))
      }
    }
    window.addEventListener("message", message)
    theme()
    const themeFrame = requestAnimationFrame(theme)
    return () => { clearTimeout(timeout); cancelAnimationFrame(themeFrame); window.removeEventListener("message", message) }
  }, [mounted, error, resolvedTheme, fontSheet])

  function close() {
    const dialog = root.current
    if (!dialog) return
    dialog.close()
    dialog.show()
    setExpanded(false)
    expandButton.current?.focus()
  }

  useNativeBackOwner(() => expanded ? root.current : null, () => {
    close()
    return "requested"
  })

  function expand() {
    const dialog = root.current
    if (!dialog) return
    setInlineHeight(dialog.getBoundingClientRect().height)
    dialog.close()
    dialog.showModal()
    setExpanded(true)
  }

  return (
    <div className="min-w-0" style={expanded ? { height: inlineHeight } : undefined}>
    <dialog
      ref={root}
      open
      role={expanded ? "dialog" : "group"}
      aria-modal={expanded || undefined}
      aria-label={attachment.name}
      data-html-preview
      data-testid={tid.htmlPreview(id)}
      data-html-preview-status={status}
      onCancel={(event) => { event.preventDefault(); close() }}
      className="relative m-0 block w-full min-w-0 max-w-full overflow-hidden rounded-none border-0 bg-transparent p-0 text-foreground backdrop:bg-background/80 [&:modal]:fixed [&:modal]:inset-0 [&:modal]:m-auto [&:modal]:flex [&:modal]:h-[calc(100dvh-2rem)] [&:modal]:max-h-none [&:modal]:w-[calc(100vw-2rem)] [&:modal]:max-w-none [&:modal]:flex-col [&:modal]:bg-background"
    >
      <div role="group" aria-label="HTML preview actions" data-html-preview-actions className="absolute top-1.5 right-1.5 z-10 flex items-center">
        <button
          type="button"
          data-testid={tid.htmlPreviewDownload(id)}
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          onClick={() => download.state.status === "downloading" ? download.cancel() : void download.start()}
          aria-label={download.state.status === "downloading" ? "Cancel download" : `Download ${attachment.name}`}
          aria-busy={download.state.status === "downloading"}
          title={attachmentDownloadStatusText(download.state) ?? `Download ${attachment.name}`}
        >
          {download.state.status === "downloading" ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <Download className="size-4" />}
          <span className="sr-only" aria-live="polite">{attachmentDownloadStatusText(download.state)}</span>
        </button>
        <button
          ref={expandButton}
          type="button"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          data-testid={expanded ? tid.htmlPreviewClose(id) : tid.htmlPreviewExpand(id)}
          aria-label={expanded ? "Close fullscreen preview" : "Expand HTML preview"}
          title={expanded ? "Close fullscreen preview" : "Expand HTML preview"}
          onClick={expanded ? close : expand}
          disabled={error && !expanded}
        >
          {expanded ? <X className="size-4" /> : <Expand className="size-4" />}
        </button>
      </div>
      {error ? (
        <div role="status" className="p-4 text-sm text-muted-foreground">Preview unavailable. You can download this file.</div>
      ) : (
        <>
          {status === "loading" && <div role="status" className="px-2 py-1 text-sm text-muted-foreground">Loading preview…</div>}
          {mounted && <iframe
            ref={frame}
            title={attachment.name}
            data-testid={tid.htmlPreviewFrame(id)}
            src={url}
            sandbox={HTML_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onLoad={() => setLoaded(true)}
            className={cn("block w-full border-0 bg-transparent scheme-light", expanded && "min-h-0 flex-1")}
            style={{ height: expanded ? undefined : height, colorScheme: loaded ? resolvedTheme === "dark" ? "dark" : "light" : undefined }}
          />}
        </>
      )}
    </dialog>
    </div>
  )
}
