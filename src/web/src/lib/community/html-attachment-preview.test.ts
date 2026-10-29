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
  it.each(["light dark", "only light"])("preserves the author's %s scheme and colors when styles load after the theme", async (scheme) => {
    const dom = new JSDOM(prepareHtmlPreview(`<!doctype html><html><head><style data-authored>:root{color-scheme:${scheme}}html,body{background:transparent}#authored{background:#73a3b2;color:#112233}</style></head><body><section id="authored">Original colors</section><input id="state" value="original"></body></html>`), {
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "parent", { value: { postMessage: vi.fn() } })
        window.requestAnimationFrame = vi.fn(() => 0)
      },
    })
    try {
      await new Promise<void>((resolve) => dom.window.document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }))
      const { document } = dom.window
      const input = document.querySelector<HTMLInputElement>("#state")!
      input.value = "retained edit"
      for (const dark of [false, true, false]) {
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window.parent, data: { type: "alook-html-theme", dark, variables: { "--background": dark ? "#121314" : "#ffffff", "--foreground": dark ? "#eeeeee" : "#111111" } } }))
        document.head.appendChild(document.querySelector("style[data-authored]")!)
        expect(dom.window.getComputedStyle(document.documentElement).colorScheme).toBe(scheme)
        for (const element of [document.documentElement, document.body]) expect(dom.window.getComputedStyle(element).backgroundColor).toBe("rgba(0, 0, 0, 0)")
        const authored = dom.window.getComputedStyle(document.querySelector("#authored")!)
        expect(authored.backgroundColor).toBe("rgb(115, 163, 178)")
        expect(authored.color).toBe("rgb(17, 34, 51)")
        expect(document.querySelector("#state")).toBe(input)
        expect(input.value).toBe("retained edit")
      }
    } finally { dom.window.close() }
  })

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
