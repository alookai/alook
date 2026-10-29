export type HtmlPreviewFont = { family: string; weight: string; style: string; url: string }

export function collectHtmlPreviewFonts(document: Document, families: string): HtmlPreviewFont[] {
  const names = new Set(families.split(",").map((name) => name.trim().replace(/^["']|["']$/g, "")))
  const fonts = new Map<string, HtmlPreviewFont>()
  function visit(rules: CSSRuleList, base: string) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const style = rule.style
        const family = style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "")
        const source = /url\(["']?([^\s"')]+)["']?\)/i.exec(style.getPropertyValue("src"))?.[1]
        if (!names.has(family) || !source) continue
        const url = new URL(source, base)
        if (url.origin !== document.location.origin || !/^\/_next\/static\/media\/[^/]+\.woff2?$/.test(url.pathname)) continue
        fonts.set(url.href, { family, weight: style.getPropertyValue("font-weight") || "400", style: style.getPropertyValue("font-style") || "normal", url: url.href })
      } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules, base)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules, sheet.href || document.location.href) } catch {}
  }
  return [...fonts.values()].slice(0, 4)
}

export async function loadHtmlPreviewFonts(fonts: readonly HtmlPreviewFont[], signal: AbortSignal): Promise<string> {
  const sheets = await Promise.all(fonts.map(async (font) => {
    const response = await fetch(font.url, { credentials: "omit", cache: "force-cache", signal })
    if (!response.ok || !response.body) throw new Error("Preview font unavailable")
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0, done = false
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) { done = true; break }
        size += chunk.value.byteLength
        if (size > 256 * 1024) throw new Error("Preview font too large")
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
      const format = font.url.endsWith(".woff2") ? "woff2" : "woff"
      return `@font-face{font-family:${JSON.stringify(font.family)};font-weight:${font.weight};font-style:${font.style};font-display:swap;src:url(data:font/${format};base64,${base64}) format("${format}")}`
    } finally {
      if (!done) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }))
  return sheets.join("")
}
