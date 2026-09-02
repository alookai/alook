"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import { tid } from "@/lib/community/testids"

export const MAX_PDF_CANVAS_PIXELS = 4_000_000

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url,
).toString()

type CanvasLayout = {
  cssWidth: number
  cssHeight: number
  outputScale: number
  pixelWidth: number
  pixelHeight: number
}

export function resolvePdfCanvasLayout(
  pageWidth: number,
  pageHeight: number,
  availableWidth: number,
  devicePixelRatio: number,
): CanvasLayout {
  const safePageWidth = Math.max(1, pageWidth)
  const safePageHeight = Math.max(1, pageHeight)
  const cssWidth = Math.max(1, availableWidth)
  const cssHeight = cssWidth * (safePageHeight / safePageWidth)
  const requestedScale = Math.min(Math.max(devicePixelRatio, 1), 2)
  const boundedScale = Math.sqrt(MAX_PDF_CANVAS_PIXELS / (cssWidth * cssHeight))
  const outputScale = Math.max(0.1, Math.min(requestedScale, boundedScale))

  return {
    cssWidth,
    cssHeight,
    outputScale,
    pixelWidth: Math.max(1, Math.floor(cssWidth * outputScale)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * outputScale)),
  }
}

type DocumentState =
  | { status: "loading"; document: null; error: null }
  | { status: "ready"; document: PDFDocumentProxy; error: null }
  | { status: "error"; document: null; error: string }

function pdfErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "PasswordException") {
    return "Password-protected PDFs aren’t supported yet"
  }
  return "Couldn’t render this PDF"
}

function useElementWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setWidth(Math.max(1, Math.floor(element.clientWidth)))
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

function PdfPage({
  document,
  pageNumber,
  availableWidth,
}: {
  document: PDFDocumentProxy
  pageNumber: number
  availableWidth: number
}) {
  const containerRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [nearby, setNearby] = useState(false)
  const [aspectRatio, setAspectRatio] = useState(8.5 / 11)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (typeof IntersectionObserver === "undefined") {
      setNearby(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearby(entry?.isIntersecting === true),
      { rootMargin: "800px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!nearby || availableWidth < 1) return
    let active = true
    let page: PDFPageProxy | null = null
    let renderTask: RenderTask | null = null
    const canvas = canvasRef.current
    setStatus("loading")

    void document.getPage(pageNumber)
      .then(async (nextPage) => {
        if (!active) {
          nextPage.cleanup()
          return
        }
        page = nextPage
        const baseViewport = page.getViewport({ scale: 1 })
        setAspectRatio(baseViewport.width / baseViewport.height)
        const layout = resolvePdfCanvasLayout(
          baseViewport.width,
          baseViewport.height,
          availableWidth,
          window.devicePixelRatio,
        )
        const viewport = page.getViewport({ scale: layout.cssWidth / baseViewport.width })
        if (!canvas) return
        canvas.width = layout.pixelWidth
        canvas.height = layout.pixelHeight
        canvas.style.width = `${layout.cssWidth}px`
        canvas.style.height = `${layout.cssHeight}px`
        renderTask = page.render({
          canvas,
          viewport,
          transform: layout.outputScale === 1
            ? undefined
            : [layout.outputScale, 0, 0, layout.outputScale, 0, 0],
        })
        await renderTask.promise
        if (active) setStatus("ready")
      })
      .catch((error: unknown) => {
        if (active && (!(error instanceof Error) || error.name !== "RenderingCancelledException")) {
          setStatus("error")
        }
      })

    return () => {
      active = false
      renderTask?.cancel()
      page?.cleanup()
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
  }, [availableWidth, document, nearby, pageNumber])

  return (
    <section
      ref={containerRef}
      data-testid={tid.pdfPreviewPage(pageNumber)}
      aria-label={`Page ${pageNumber}`}
      className="relative w-full overflow-hidden rounded-lg bg-background shadow-(--e1)"
      style={{ aspectRatio }}
    >
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          Loading page {pageNumber}…
        </div>
      )}
      {status === "error" && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Couldn’t render page {pageNumber}
        </div>
      )}
      <canvas
        ref={canvasRef}
        aria-label={`Rendered page ${pageNumber}`}
        className={status === "ready" ? "block h-auto w-full" : "invisible block h-auto w-full"}
      />
    </section>
  )
}

function PdfPages({ document }: { document: PDFDocumentProxy }) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const availableWidth = useElementWidth(pagesRef)

  return (
    <div className="p-4">
      <div ref={pagesRef} className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {Array.from({ length: document.numPages }, (_, index) => (
          <PdfPage
            key={index + 1}
            document={document}
            pageNumber={index + 1}
            availableWidth={availableWidth}
          />
        ))}
      </div>
    </div>
  )
}

export function PdfPreview({ data }: { data: Uint8Array<ArrayBuffer> }) {
  const [state, setState] = useState<DocumentState>({
    status: "loading",
    document: null,
    error: null,
  })

  useEffect(() => {
    let active = true
    const worker = new PDFWorker()
    let loadingTask: PDFDocumentLoadingTask | null = null
    setState({ status: "loading", document: null, error: null })

    try {
      loadingTask = getDocument({
        data: data.slice(),
        worker,
        useSystemFonts: true,
        useWasm: false,
        maxImageSize: MAX_PDF_CANVAS_PIXELS,
        canvasMaxAreaInBytes: MAX_PDF_CANVAS_PIXELS * 4,
      })
      void loadingTask.promise
        .then((document) => {
          if (active) setState({ status: "ready", document, error: null })
        })
        .catch((error: unknown) => {
          if (active) setState({ status: "error", document: null, error: pdfErrorMessage(error) })
        })
    } catch (error) {
      setState({ status: "error", document: null, error: pdfErrorMessage(error) })
    }

    return () => {
      active = false
      if (!loadingTask) {
        worker.destroy()
        return
      }
      void loadingTask.destroy().finally(() => {
        if (!worker.destroyed) worker.destroy()
      })
    }
  }, [data])

  return (
    <div
      data-testid={tid.pdfPreview}
      className="min-h-0 flex-1 overflow-y-auto bg-muted/40 thin-scrollbar"
    >
      {state.status === "loading" && (
        <div
          data-testid={tid.pdfPreviewStatus}
          role="status"
          className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          Loading PDF…
        </div>
      )}
      {state.status === "error" && (
        <div
          data-testid={tid.pdfPreviewStatus}
          role="alert"
          className="flex min-h-40 items-center justify-center text-sm text-muted-foreground"
        >
          {state.error}
        </div>
      )}
      {state.status === "ready" && (
        <PdfPages document={state.document} />
      )}
    </div>
  )
}
