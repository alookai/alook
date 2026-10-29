import { JSDOM } from "jsdom"
import { describe, expect, it, vi } from "vitest"
import { HTML_PREVIEW_CSP, HtmlPreviewValidationError, prepareHtmlPreview, readHtmlPreview } from "./html-attachment-preview"
import { MAX_HTML_PREVIEW_BYTES } from "./html-preview-policy"

const stream = (text: string) => new Response(text).body!
describe("HTML preview response preparation", () => {
  it("reads UTF-8 split across byte chunks", async () => {
    const bytes = new TextEncoder().encode("<p>你好</p>")
    const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    expect(await readHtmlPreview(body)).toBe("<p>你好</p>")
  })
  it.each(["", " \n", "a\0b"])("rejects empty or binary input", async (text) => {
    await expect(readHtmlPreview(stream(text))).rejects.toBeInstanceOf(HtmlPreviewValidationError)
  })
  it("rejects invalid UTF-8 and overflow based on real bytes", async () => {
    await expect(readHtmlPreview(new Response(new Uint8Array([255])).body!)).rejects.toThrow("UTF-8")
    const cancel = vi.fn()
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_HTML_PREVIEW_BYTES + 1)) }, cancel })
    await expect(readHtmlPreview(body)).rejects.toThrow("limit")
    expect(cancel).toHaveBeenCalledOnce()
  })
  it("cancels a pending read when its request aborts", async () => {
    const abort = new AbortController(), cancel = vi.fn()
    const result = readHtmlPreview(new ReadableStream({ cancel }), abort.signal)
    abort.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['<style>body{height:100vh}</style>', '<p style="min-height:50dvh">x</p>', "<div style='height:80svh'>x</div>"])("rejects CSS viewport feedback loops", (html) => {
    expect(() => prepareHtmlPreview(html)).toThrow(HtmlPreviewValidationError)
  })
  it("does not reject ordinary text, comments or base64 containing vh", () => {
    expect(() => prepareHtmlPreview('<p>100vh</p><!-- style="height:100vh" --><img src="data:image/png;base64,100vhAA">')).not.toThrow()
  })
  it("runs the bootstrap before original scripts for documents and fragments", () => {
    for (const html of ['<!doctype html><html><head><script>original()</script></head><body>x</body></html>', '<script>original()</script><p>x</p>', '<!-- <head> --><p>x</p>']) {
      const result = prepareHtmlPreview(html)
      expect(result).toContain(html.replace(/^<!doctype html>/i, ""))
      expect(result.indexOf("alook-html-ready")).toBeLessThan(result.indexOf("original()") === -1 ? result.length : result.indexOf("original()"))
    }
    expect(HTML_PREVIEW_CSP).toContain("sandbox allow-scripts")
    expect(HTML_PREVIEW_CSP).not.toContain("allow-same-origin")
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("base-uri 'none'")
  })
})


describe("generated HTML bootstrap", () => {
  it("requests the host theme, reports readiness and rejects a different sender", async () => {
    const post = vi.fn()
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const dom = new JSDOM(prepareHtmlPreview('<html><head><title>Fixture</title></head><body><button>Works</button><script>document.body.dataset.original="executed"</script></body></html>'), {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: { postMessage: post } })
        window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId }
        window.cancelAnimationFrame = (id) => { frames.delete(id) }
      },
    })
    try {
      await new Promise<void>((resolve) => dom.window.document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }))
      expect(dom.window.document.title).toBe("Fixture")
      expect(dom.window.document.body.dataset.original).toBe("executed")
      expect(post).toHaveBeenCalledWith({ type: "alook-html-theme-request" }, "*")
      expect(post).toHaveBeenCalledWith({ type: "alook-html-ready" }, "*")
      const data = { type: "alook-html-theme", dark: true, variables: { "--background": "#123456", "--foreground": "#abcdef", "--bad": "red;}<script>" } }
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window, data }))
      expect(dom.window.document.documentElement.classList.contains("dark")).toBe(false)
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window.parent, data }))
      expect(dom.window.document.documentElement.classList.contains("dark")).toBe(true)
      expect(dom.window.document.getElementById("alook-preview-theme")!.textContent).toContain("--background:#123456")
      expect(dom.window.document.getElementById("alook-preview-theme")!.textContent).not.toContain("--bad")
      for (const [id, callback] of frames) { frames.delete(id); callback(0) }
      expect(post).toHaveBeenCalledWith({ type: "alook-html-height", height: 80 }, "*")
    } finally { frames.clear(); dom.window.close() }
  })
})
