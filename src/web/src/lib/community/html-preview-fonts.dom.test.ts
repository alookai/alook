import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { render } from "@/test/react-dom-harness"
import { collectHtmlPreviewFonts, loadHtmlPreviewFonts } from "./html-preview-fonts"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("HTML preview host fonts", () => {
  it("selects only named public Next font assets from the current host", () => {
    const view = render(createElement("style", null, '@font-face{font-family:"Host Sans";font-weight:400 900;src:url("/_next/static/media/sans.woff2")}@font-face{font-family:Other;src:url("/_next/static/media/other.woff2")}@font-face{font-family:"Host Sans";src:url("https://external.test/secret.woff2")}@font-face{font-family:"Host Sans";src:url("/api/private.woff2")}'))
    const style = view.container.querySelector("style")!
    const sources = ['url("/_next/static/media/sans.woff2")', 'url("/_next/static/media/other.woff2")', 'url("https://external.test/secret.woff2")', 'url("/api/private.woff2")']
    Array.from(style.sheet!.cssRules).forEach((rule, index) => {
      const declaration = (rule as CSSFontFaceRule).style
      const original = declaration.getPropertyValue.bind(declaration)
      vi.spyOn(declaration, "getPropertyValue").mockImplementation((name) => name === "src" ? sources[index]! : name === "font-weight" ? "400 900" : original(name))
    })
    try {
      expect(collectHtmlPreviewFonts(document, '"Host Sans", serif')).toEqual([{ family: "Host Sans", weight: "400 900", style: "normal", url: new URL("/_next/static/media/sans.woff2", location.href).href }])
    } finally { view.unmount() }
  })
  it("embeds bounded public font bytes without credentials, bypassing opaque-origin font CORS", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal("fetch", fetch)
    const font = { family: "Host Sans", weight: "400 900", style: "normal", url: "http://localhost/_next/static/media/sans.woff2" }
    const abort = new AbortController()
    const css = await loadHtmlPreviewFonts([font], abort.signal)
    expect(fetch).toHaveBeenCalledWith(font.url, { credentials: "omit", cache: "force-cache", signal: abort.signal })
    expect(css).toContain("data:font/woff2;base64,AQID")
    expect(css).toContain('font-family:"Host Sans"')
    expect(css).not.toContain(font.url)
    const cancel = vi.fn()
    fetch.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(256 * 1024 + 1)) }, cancel })))
    await expect(loadHtmlPreviewFonts([font], abort.signal)).rejects.toThrow("too large")
    expect(cancel).toHaveBeenCalledOnce()
  })
})
