import { HTML_PREVIEW_SANDBOX, MAX_HTML_PREVIEW_BYTES } from "./html-preview-policy"

export const HTML_PREVIEW_CSP = [
  `sandbox ${HTML_PREVIEW_SANDBOX}`,
  "default-src 'none'",
  "script-src https: 'unsafe-inline' 'unsafe-eval'",
  "style-src https: 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src https: data:",
  "connect-src https:",
  "media-src https: data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action https:",
  "frame-ancestors 'self'",
].join("; ")

export class HtmlPreviewValidationError extends Error {}

export async function readHtmlPreview(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  function decode(value?: Uint8Array, stream = false) {
    try { return decoder.decode(value, { stream }) }
    catch { throw new HtmlPreviewValidationError("HTML must use UTF-8") }
  }
  let size = 0, html = "", finished = false
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) { finished = true; break }
      size += value.byteLength
      if (size > MAX_HTML_PREVIEW_BYTES) throw new HtmlPreviewValidationError("HTML exceeds the preview limit")
      html += decode(value, true)
    }
    html += decode()
    if (!html.trim() || html.includes("\0")) throw new HtmlPreviewValidationError("Invalid HTML document")
    return html
  } finally {
    signal?.removeEventListener("abort", abort)
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const CSS_SOURCE = /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi
const VIEWPORT_HEIGHT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i

const BASE_CSS = "html{background:transparent;color:var(--foreground);font-family:var(--font-sans,system-ui);font-size:15px;line-height:1.6;color-scheme:light dark}body{margin:0;background:transparent}code,pre,kbd,samp{font-family:var(--font-mono,monospace)}:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}"
const BOOTSTRAP = String.raw`(() => {
  const framed = window.parent !== window;
  const themeStyle = document.getElementById("alook-preview-theme");
  let lastHeight = 0;
  let pending = false;
  function send(type, fields) {
    if (framed) parent.postMessage({ type, ...fields }, "*");
  }
  function measure() {
    pending = false;
    if (!document.body) return;
    const root = document.documentElement;
    const measured = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    const height = Math.max(80, Math.min(2000, measured));
    if (height !== lastHeight) {
      lastHeight = height;
      send("alook-html-height", { height });
    }
  }
  function schedule() {
    for (const element of [document.documentElement, document.body]) {
      if (element && (element.style.getPropertyValue("background") !== "transparent" || element.style.getPropertyPriority("background") !== "important")) {
        element.style.setProperty("background", "transparent", "important");
      }
    }
    if (pending) return;
    pending = true;
    requestAnimationFrame(measure);
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== "alook-html-theme" || !data.variables || typeof data.variables !== "object") return;
    let css = ":root{color-scheme:" + (data.dark ? "dark" : "light") + ";";
    for (const key in data.variables) {
      const value = data.variables[key];
      if (/^--[a-z-]+$/.test(key) && typeof value === "string" && value.length < 1024 && !/[;{}<>]/.test(value)) css += key + ":" + value + ";";
    }
    themeStyle.textContent = css + "}" + (typeof data.fontSheet === "string" && data.fontSheet.length <= 1500000 ? data.fontSheet : "");
    document.documentElement.classList.toggle("dark", data.dark === true);
    schedule();
  });
  if (window.MutationObserver) new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  schedule();
  send("alook-html-theme-request");
  document.addEventListener("DOMContentLoaded", () => {
    send("alook-html-ready");
    schedule();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(schedule);
      observer.observe(document.documentElement);
      observer.observe(document.body);
    }
  });
  window.addEventListener("load", schedule);
  document.addEventListener("load", schedule, true);
})();`


export function prepareHtmlPreview(html: string): string {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    if (VIEWPORT_HEIGHT.test(sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "")) {
      throw new HtmlPreviewValidationError("Use content height instead of viewport height units")
    }
  }
  const prefix = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><style id="alook-preview-theme"></style><script>${BOOTSTRAP}</script>`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype
    ? html.slice(0, doctype[0].length) + prefix + html.slice(doctype[0].length)
    : `<!doctype html>${prefix}${html}`
}
