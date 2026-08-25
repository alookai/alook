import { isIP } from "node:net"
import { getPreviewFromContent } from "link-preview-js/mobile"
import type { LinkPreview } from "./link-preview"

const MAX_URL_LENGTH = 2_048
const MAX_HTML_BYTES = 128 * 1024
const MAX_REDIRECTS = 3
const TOTAL_TIMEOUT_MS = 3_000
const CONTROL_AND_BIDI_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const SPECIAL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
]

function ipv4Bytes(hostname: string): number[] | null {
  if (isIP(hostname) !== 4) return null
  const bytes = hostname.split(".").map(Number)
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null
}

function ipv6Words(hostname: string): number[] | null {
  const host = hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) !== 6) return null
  const [leftRaw, rightRaw] = host.split("::")
  const left = leftRaw ? leftRaw.split(":") : []
  const right = rightRaw ? rightRaw.split(":") : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (!host.includes("::") && missing !== 0)) return null
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  const words = parts.map((part) => Number.parseInt(part || "0", 16))
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null
}

function isPublicIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function isPublicIpv6(words: number[]): boolean {
  // IPv4-mapped IPv6 must inherit the embedded IPv4 decision.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ])
  }

  // Only globally-routable unicast (2000::/3), excluding special-use ranges.
  if ((words[0] & 0xe000) !== 0x2000) return false
  if (words[0] === 0x2001) {
    const second = words[1]
    if (second === 0x0000 || second === 0x0002 || second === 0x000d || second === 0x0db8) return false
    if ((second & 0xfff0) === 0x0010) return false
  }
  // 6to4 can tunnel to an embedded private IPv4 destination.
  if (words[0] === 0x2002) return false
  return true
}

function isSpecialHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost") return true
  return SPECIAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Parse, canonicalize, and reject targets outside the public HTTP(S) web. */
export function normalizePublicPreviewUrl(input: string): URL {
  if (!input || input.length > MAX_URL_LENGTH) throw new Error("invalid preview URL")
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("invalid preview URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported preview protocol")
  if (url.username || url.password || url.port) throw new Error("unsupported preview authority")
  if (!url.hostname || isSpecialHostname(url.hostname)) throw new Error("non-public preview host")

  const host = url.hostname.replace(/^\[|\]$/g, "")
  const ipVersion = isIP(host)
  if (ipVersion === 4 && !isPublicIpv4(ipv4Bytes(host)!)) throw new Error("non-public preview host")
  if (ipVersion === 6 && !isPublicIpv6(ipv6Words(host)!)) throw new Error("non-public preview host")

  url.hash = ""
  return url
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined
  const cleaned = value
    .replace(CONTROL_AND_BIDI_RE, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return undefined
  return Array.from(cleaned).slice(0, maxLength).join("")
}

async function readBoundedHtml(response: Response): Promise<string> {
  if (!response.body) throw new Error("preview response has no body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let html = ""
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const remaining = MAX_HTML_BYTES - total
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      total += chunk.byteLength
      html += decoder.decode(chunk, { stream: true })

      // Metadata belongs in <head>. Stop as soon as it is complete, and also
      // stop at the byte ceiling instead of rejecting otherwise-valid pages
      // whose full body is large (GitHub PR pages routinely exceed the cap).
      if (/<\/head\s*>/i.test(html) || total === MAX_HTML_BYTES) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return html + decoder.decode()
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function fetchHtml(start: URL, signal: AbortSignal): Promise<{ html: string; finalUrl: URL; contentType: string }> {
  let current = start
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Alook-Link-Preview/1.0",
      },
      referrerPolicy: "no-referrer",
    })

    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => {})
      if (redirects === MAX_REDIRECTS) throw new Error("too many preview redirects")
      const location = response.headers.get("location")
      if (!location) throw new Error("invalid preview redirect")
      current = normalizePublicPreviewUrl(new URL(location, current).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error("preview origin rejected request")
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!/^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/.test(contentType)) {
      await response.body?.cancel().catch(() => {})
      throw new Error("preview response is not HTML")
    }
    return { html: await readBoundedHtml(response), finalUrl: current, contentType }
  }
  throw new Error("too many preview redirects")
}

/**
 * Fetch one public page within a single hard budget and return sanitized,
 * plain-text metadata only. Remote HTML and media URLs never cross this API.
 */
export async function fetchLinkPreview(input: string): Promise<LinkPreview> {
  const original = normalizePublicPreviewUrl(input)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  try {
    const { html, finalUrl, contentType } = await fetchHtml(original, controller.signal)
    const parsed = await getPreviewFromContent({
      url: finalUrl.href,
      data: html,
      headers: { "content-type": contentType },
    }, {
      imagesPropertyType: "og",
      // link-preview-js covers Open Graph + ordinary title/description but
      // not pages that expose Twitter Card tags only. Fill only its gaps.
      onResponse: (response, doc) => ({
        ...response,
        title: response.title
          || doc("meta[name='twitter:title'],meta[property='twitter:title']").first().attr("content")
          || "",
        description: response.description
          || doc("meta[name='twitter:description'],meta[property='twitter:description']").first().attr("content"),
      }),
    })
    const record = parsed as Record<string, unknown>
    const parsedTitle = cleanText(record.title, 160)
    const description = cleanText(record.description, 320)
    const siteName = cleanText(record.siteName, 80)
    if (!parsedTitle && !description) throw new Error("preview metadata missing")
    const title = parsedTitle ?? siteName ?? original.hostname
    return {
      url: original.href,
      hostname: original.hostname,
      title,
      ...(description ? { description } : {}),
      ...(siteName ? { siteName } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

export const LINK_PREVIEW_LIMITS = {
  maxHtmlBytes: MAX_HTML_BYTES,
  maxRedirects: MAX_REDIRECTS,
  timeoutMs: TOTAL_TIMEOUT_MS,
} as const
