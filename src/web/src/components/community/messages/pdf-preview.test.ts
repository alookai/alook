import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

function nodeMock(element: React.ReactElement) {
  if (element.type === "div") return { clientWidth: 600 }
  if (element.type === "section") return {}
  if (element.type === "canvas") return { width: 0, height: 0, style: {} }
  return null
}

beforeEach(() => {
  pdfMock.getDocument.mockReset()
  pdfMock.workers.length = 0
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("window", { devicePixelRatio: 3 })
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
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, { data }), {
        createNodeMock: nodeMock,
      })
    })
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
    expect(renderer!.root.findByProps({ "data-testid": "community-pdf-preview-page-1" })).toBeTruthy()
    expect(renderer!.root.findByProps({ "data-testid": "community-pdf-preview-page-2" })).toBeTruthy()

    await act(async () => renderer!.unmount())
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
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })
    await flush()

    const alert = renderer!.root.findByProps({ role: "alert" })
    expect(alert.children.join("")).toContain("Password-protected PDFs")
    expect(renderer!.root.findAllByType("canvas")).toHaveLength(0)
  })

  it("reports synchronous setup errors and destroys the standalone worker", async () => {
    pdfMock.getDocument.mockImplementation(() => {
      throw new Error("invalid PDF")
    })
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })

    expect(renderer!.root.findByProps({ role: "alert" }).children.join(""))
      .toContain("Couldn’t render this PDF")
    await act(async () => renderer!.unmount())
    expect(pdfMock.workers[0]!.destroy).toHaveBeenCalledOnce()
  })

  it("renders when observer APIs are unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined)
    vi.stubGlobal("IntersectionObserver", undefined)
    const visiblePage = page()
    const document = documentWithPages([visiblePage])
    pdfMock.getDocument.mockReturnValue(loadingTask(document))

    await act(async () => {
      TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })
    await flush()

    expect(visiblePage.render).toHaveBeenCalledOnce()
  })

  it("stays idle when layout refs are unavailable", async () => {
    const hiddenPage = page()
    const document = documentWithPages([hiddenPage])
    pdfMock.getDocument.mockReturnValue(loadingTask(document))

    await act(async () => {
      TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }))
    })
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
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })
    await flush()
    await act(async () => renderer!.unmount())
    resolvePage(latePage)
    await flush()

    expect(latePage.cleanup).toHaveBeenCalledOnce()
    expect(latePage.render).not.toHaveBeenCalled()
  })

  it("reports page render failures and tolerates a missing canvas ref", async () => {
    const failedPage = page()
    let rejectRender!: (error: Error) => void
    failedPage.renderTask.promise = new Promise<void>((_resolve, reject) => {
      rejectRender = reject
    })
    const failedDocument = documentWithPages([failedPage])
    pdfMock.getDocument.mockReturnValueOnce(loadingTask(failedDocument))
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })
    await flush()
    rejectRender(new Error("paint failed"))
    await flush()
    expect(renderer!.root.findByProps({ role: "alert" }).children.join(""))
      .toContain("Couldn’t render page 1")
    await act(async () => renderer!.unmount())

    const canvaslessPage = page()
    pdfMock.getDocument.mockReturnValueOnce(loadingTask(documentWithPages([canvaslessPage])))
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([2]),
      }), {
        createNodeMock: (element) => element.type === "canvas" ? null : nodeMock(element),
      })
    })
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
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PdfPreview, {
        data: new Uint8Array([1]),
      }), { createNodeMock: nodeMock })
    })
    await act(async () => {
      renderer!.update(React.createElement(PdfPreview, { data: new Uint8Array([2]) }))
    })
    await flush()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(secondDocument.getPage).toHaveBeenCalledOnce()

    resolveFirst(documentWithPages([page(), page()]))
    await flush()
    expect(renderer!.root.findAll((node) => node.props["data-testid"]?.startsWith("community-pdf-preview-page-")))
      .toHaveLength(1)
  })
})
