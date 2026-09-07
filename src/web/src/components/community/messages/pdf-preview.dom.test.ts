import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const pdfMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workers: [] as Array<{ destroyed: boolean; destroy: ReturnType<typeof vi.fn> }>,
  workerOptions: { workerSrc: "" },
}))

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: pdfMock.workerOptions,
  PDFWorker: class {
    destroyed = false
    destroy = vi.fn(() => {
      this.destroyed = true
    })

    constructor() {
      pdfMock.workers.push(this)
    }
  },
  getDocument: pdfMock.getDocument,
}))

import {
  MAX_PDF_CANVAS_PIXELS,
  PdfPreview,
  resolvePdfCanvasLayout,
} from "./pdf-preview"

function page(width = 600, height = 800) {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() }
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    })),
    render: vi.fn(() => renderTask),
    cleanup: vi.fn(),
    renderTask,
  }
}

function documentWithPages(pages: ReturnType<typeof page>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn((pageNumber: number) => Promise.resolve(pages[pageNumber - 1])),
  }
}

function loadingTask(document: ReturnType<typeof documentWithPages>) {
  return {
    promise: Promise.resolve(document),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

let clientWidthDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  pdfMock.getDocument.mockReset()
  pdfMock.workers.length = 0
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 })
  clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 600,
  })
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { this.callback() }
    disconnect() {}
  })
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.callback([{ isIntersecting: true }]) }
    disconnect() {}
  })
})

afterEach(() => {
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor)
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  }
  vi.unstubAllGlobals()
})

describe("resolvePdfCanvasLayout", () => {
  it("fits the page width, caps retina scale, and never exceeds the pixel budget", () => {
    const layout = resolvePdfCanvasLayout(600, 800, 1200, 4)
    expect(layout).toMatchObject({ cssWidth: 1200, cssHeight: 1600 })
    expect(layout.outputScale).toBeLessThan(2)
    expect(layout.pixelWidth * layout.pixelHeight).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS)
  })
})

describe("PdfPreview", () => {
  it("loads owned bytes in one worker and lazily renders every visible page", async () => {
    const pages = [page(), page(800, 600)]
    const document = documentWithPages(pages)
    const task = loadingTask(document)
    pdfMock.getDocument.mockReturnValue(task)
    const data = new Uint8Array([37, 80, 68, 70])
    const renderer = render(React.createElement(PdfPreview, { data }))
    await flush()

    expect(pdfMock.workerOptions.workerSrc).toContain("legacy/build/pdf.worker.min.mjs")
    expect(pdfMock.workers).toHaveLength(1)
    expect(pdfMock.getDocument).toHaveBeenCalledOnce()
    const options = pdfMock.getDocument.mock.calls[0]![0]
    expect(options.data).toEqual(data)
    expect(options.data).not.toBe(data)
    expect(options).toMatchObject({
      useSystemFonts: true,
      useWasm: false,
      maxImageSize: MAX_PDF_CANVAS_PIXELS,
      canvasMaxAreaInBytes: MAX_PDF_CANVAS_PIXELS * 4,
    })
    expect(document.getPage).toHaveBeenCalledTimes(2)
    expect(pages.every((value) => value.render.mock.calls.length === 1)).toBe(true)
    expect(renderer.container.querySelector(
      '[data-testid="community-pdf-preview-page-1"]',
    )).not.toBeNull()
    expect(renderer.container.querySelector(
      '[data-testid="community-pdf-preview-page-2"]',
    )).not.toBeNull()

    renderer.unmount()
    await flush()
    expect(pages.every((value) => value.renderTask.cancel.mock.calls.length === 1)).toBe(true)
    expect(pages.every((value) => value.cleanup.mock.calls.length === 1)).toBe(true)
    expect(task.destroy).toHaveBeenCalledOnce()
    expect(pdfMock.workers[0]!.destroy).toHaveBeenCalledOnce()
  })

  it("reports document errors without creating page canvases", async () => {
    const error = new Error("password required")
    error.name = "PasswordException"
    const task = {
      promise: Promise.reject(error),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    pdfMock.getDocument.mockReturnValue(task)
    const renderer = render(React.createElement(PdfPreview, {
      data: new Uint8Array([1]),
    }))
    await flush()

    const alert = renderer.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Password-protected PDFs")
    expect(renderer.container.querySelectorAll("canvas")).toHaveLength(0)
  })

  it("reports synchronous setup errors and destroys the standalone worker", async () => {
    pdfMock.getDocument.mockImplementation(() => {
      throw new Error("invalid PDF")
    })
    const renderer = render(React.createElement(PdfPreview, {
      data: new Uint8Array([1]),
    }))

    expect(renderer.container.querySelector('[role="alert"]')?.textContent)
      .toContain("Couldn’t render this PDF")
    renderer.unmount()
    expect(pdfMock.workers[0]!.destroy).toHaveBeenCalledOnce()
  })

  it("renders when observer APIs are unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined)
    vi.stubGlobal("IntersectionObserver", undefined)
    const visiblePage = page()
    const document = documentWithPages([visiblePage])
    pdfMock.getDocument.mockReturnValue(loadingTask(document))

    render(React.createElement(PdfPreview, { data: new Uint8Array([1]) }))
    await flush()

    expect(visiblePage.render).toHaveBeenCalledOnce()
  })

  it("does not request pages after the preview unmounts before document load", async () => {
    let resolveDocument!: (value: ReturnType<typeof documentWithPages>) => void
    const document = documentWithPages([page()])
    const task = {
      promise: new Promise<ReturnType<typeof documentWithPages>>((resolve) => {
        resolveDocument = resolve
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    pdfMock.getDocument.mockReturnValue(task)

    const renderer = render(React.createElement(PdfPreview, { data: new Uint8Array([1]) }))
    renderer.unmount()
    resolveDocument(document)
    await flush()

    expect(document.getPage).not.toHaveBeenCalled()
  })

  it("releases a page that resolves after its render generation closes", async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    const latePage = page()
    const document = {
      numPages: 1,
      getPage: vi.fn(() => new Promise<ReturnType<typeof page>>((resolve) => {
        resolvePage = resolve
      })),
    }
    pdfMock.getDocument.mockReturnValue(loadingTask(document as ReturnType<typeof documentWithPages>))
    const renderer = render(React.createElement(PdfPreview, {
      data: new Uint8Array([1]),
    }))
    await flush()
    renderer.unmount()
    resolvePage(latePage)
    await flush()

    expect(latePage.cleanup).toHaveBeenCalledOnce()
    expect(latePage.render).not.toHaveBeenCalled()
  })

  it("reports page render failures and skips a generation unmounted before paint", async () => {
    const failedPage = page()
    let rejectRender!: (error: Error) => void
    failedPage.renderTask.promise = new Promise<void>((_resolve, reject) => {
      rejectRender = reject
    })
    const failedDocument = documentWithPages([failedPage])
    pdfMock.getDocument.mockReturnValueOnce(loadingTask(failedDocument))
    const renderer = render(React.createElement(PdfPreview, {
      data: new Uint8Array([1]),
    }))
    await flush()
    rejectRender(new Error("paint failed"))
    await flush()
    expect(renderer.container.querySelector('[role="alert"]')?.textContent)
      .toContain("Couldn’t render page 1")
    renderer.unmount()

    const canvaslessPage = page()
    pdfMock.getDocument.mockReturnValueOnce(loadingTask(documentWithPages([canvaslessPage])))
    const canvasless = render(React.createElement(PdfPreview, { data: new Uint8Array([2]) }))
    canvasless.unmount()
    await flush()
    expect(canvaslessPage.render).not.toHaveBeenCalled()
  })

  it("destroys a replaced loading generation and ignores its late result", async () => {
    let resolveFirst!: (document: ReturnType<typeof documentWithPages>) => void
    const first = {
      promise: new Promise<ReturnType<typeof documentWithPages>>((resolve) => {
        resolveFirst = resolve
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const secondPage = page()
    const secondDocument = documentWithPages([secondPage])
    const second = loadingTask(secondDocument)
    pdfMock.getDocument.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const renderer = render(React.createElement(PdfPreview, {
      data: new Uint8Array([1]),
    }))
    renderer.rerender(React.createElement(PdfPreview, { data: new Uint8Array([2]) }))
    await flush()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(secondDocument.getPage).toHaveBeenCalledOnce()

    resolveFirst(documentWithPages([page(), page()]))
    await flush()
    expect(renderer.container.querySelectorAll('[data-testid^="community-pdf-preview-page-"]'))
      .toHaveLength(1)
  })
})
