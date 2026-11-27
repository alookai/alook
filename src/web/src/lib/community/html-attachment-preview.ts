import { HTML_PREVIEW_SANDBOX, MAX_HTML_PREVIEW_BYTES } from "./html-preview-policy"

export const HTML_PREVIEW_CSP = [
  `sandbox ${HTML_PREVIEW_SANDBOX}`,
  "default-src 'none'",
  "script-src https: 'unsafe-inline' 'unsafe-eval'",
  "style-src https: 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src https: data:",
  "connect-src 'none'",
  "media-src https: data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
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

const BASE_CSS = "html{background:transparent;color:var(--foreground);font-family:var(--font-sans,system-ui);font-size:15px;line-height:1.6;color-scheme:light dark;overscroll-behavior:auto;scrollbar-width:none;-ms-overflow-style:none}body{margin:0;background:transparent;scrollbar-width:none;-ms-overflow-style:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;width:0;height:0}code,pre,kbd,samp{font-family:var(--font-mono,monospace)}:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}"
const BOOTSTRAP = String.raw`(() => {
  const framed = window.parent !== window;
  const themeStyle = document.getElementById("alook-preview-theme");
  const fontStyle = document.getElementById("alook-preview-fonts");
  let lastHeight = 0;
  let lastScrollTop = -1;
  let lastScrollHeight = -1;
  let lastClientHeight = -1;
  let pending = false;
  let scrollPending = false;
  function send(type, fields) {
    if (framed) parent.postMessage({ type, ...fields }, "*");
  }
  function reportScroll() {
    scrollPending = false;
    const root = document.documentElement;
    if (!root) return;
    const scrollTop = Math.max(0, window.scrollY || root.scrollTop || 0);
    const scrollHeight = Math.max(0, root.scrollHeight || 0);
    const clientHeight = Math.max(0, root.clientHeight || window.innerHeight || 0);
    if (scrollTop === lastScrollTop && scrollHeight === lastScrollHeight && clientHeight === lastClientHeight) return;
    lastScrollTop = scrollTop;
    lastScrollHeight = scrollHeight;
    lastClientHeight = clientHeight;
    send("alook-html-scroll", { scrollTop, scrollHeight, clientHeight });
  }
  function scheduleScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(reportScroll);
  }
  function measure() {
    pending = false;
    if (!document.body) return;
    const root = document.documentElement;
    const rootRect = root.getBoundingClientRect().height;
    const measured = Math.ceil(root.scrollHeight > root.clientHeight ? Math.max(root.scrollHeight, rootRect) : Math.max(rootRect, document.body.scrollHeight));
    const height = Math.max(80, Math.min(2000, measured));
    if (height !== lastHeight) {
      lastHeight = height;
      send("alook-html-height", { height });
    }
    reportScroll();
  }
  function schedule() {
    if (typeof document === "undefined" || !document.documentElement) return;
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
    if (event.source !== parent || !data || typeof data !== "object") return;
    if (data.type === "alook-html-scroll-to") {
      if (typeof data.top === "number" && Number.isFinite(data.top)) {
        const root = document.documentElement;
        const max = Math.max(0, (root ? root.scrollHeight : 0) - (root ? root.clientHeight : window.innerHeight || 0));
        const target = Math.max(0, Math.min(max, data.top));
        if (typeof window.scrollTo === "function") window.scrollTo(0, target);
        else if (root) root.scrollTop = target;
        scheduleScroll();
      }
      return;
    }
    if (data.type !== "alook-html-theme" || !data.variables || typeof data.variables !== "object") return;
    let css = ":root{color-scheme:" + (data.dark ? "dark" : "light") + ";";
    for (const key in data.variables) {
      const value = data.variables[key];
      if (/^--[a-z-]+$/.test(key) && typeof value === "string" && value.length < 1024 && !/[;{}<>]/.test(value)) css += key + ":" + value + ";";
    }
    themeStyle.textContent = css + "}";
    if (fontStyle && typeof data.fontSheet === "string" && data.fontSheet.length <= 1500000) {
      fontStyle.textContent = data.fontSheet;
    }
    document.documentElement.classList.toggle("dark", data.dark === true);
    schedule();
  });
  if (window.MutationObserver) new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  window.addEventListener("scroll", scheduleScroll, { passive: true });
  window.addEventListener("resize", scheduleScroll, { passive: true });
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
  const prefix = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_CSS}</style><style id="alook-preview-theme"></style><style id="alook-preview-fonts"></style><script>${BOOTSTRAP}</script>`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype
    ? html.slice(0, doctype[0].length) + prefix + html.slice(doctype[0].length)
    : `<!doctype html>${prefix}${html}`
}
