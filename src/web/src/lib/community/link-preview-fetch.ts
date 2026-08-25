import { isIP } from "node:net"
import { getPreviewFromContent } from "link-preview-js/mobile"
import type { LinkPreview } from "./link-preview"

export type FetchedLinkPreview = LinkPreview & { thumbnailSource?: string }

const MAX_URL_LENGTH = 2_048
const MAX_HTML_BYTES = 128 * 1024
const MAX_OEMBED_BYTES = 16 * 1024
const MAX_REDIRECTS = 3
const TOTAL_TIMEOUT_MS = 3_000
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
])
const YOUTUBE_NOCOOKIE_HOSTS = new Set([
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
])
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

function cleanThumbnailSource(value: unknown, base: URL): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  try {
    const source = normalizePublicPreviewUrl(new URL(value, base).href)
    return source.protocol === "https:" ? source.href : undefined
  } catch {
    return undefined
  }
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase()
  let candidate: string | null = null
  if (host === "youtu.be" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    candidate = url.pathname.split("/")[1] ?? null
  } else if (YOUTUBE_HOSTS.has(host) && url.pathname === "/watch") {
    candidate = url.searchParams.get("v")
  } else if (YOUTUBE_HOSTS.has(host) && /^\/(?:shorts|embed|live)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    candidate = url.pathname.split("/")[2] ?? null
  } else if (YOUTUBE_NOCOOKIE_HOSTS.has(host) && /^\/embed\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    candidate = url.pathname.split("/")[2] ?? null
  }
  return candidate && YOUTUBE_VIDEO_ID_RE.test(candidate) ? candidate : null
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("preview response has no body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        await reader.cancel()
        throw new Error("preview response is too large")
      }
      total += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return text + decoder.decode()
}

async function fetchYouTubeOEmbed(original: URL, videoId: string, signal: AbortSignal): Promise<FetchedLinkPreview> {
  // The destination is fixed rather than derived from user input. The source
  // URL is only an encoded oEmbed parameter, so it cannot steer the fetch.
  const endpoint = new URL("https://www.youtube.com/oembed")
  endpoint.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`)
  endpoint.searchParams.set("format", "json")
  const response = await fetch(endpoint.href, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error("YouTube oEmbed rejected request")
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!/^application\/(?:[\w.+-]+\+)?json(?:;|$)/.test(contentType)) {
    await response.body?.cancel().catch(() => {})
    throw new Error("YouTube oEmbed response is not JSON")
  }

  const record = JSON.parse(await readBoundedText(response, MAX_OEMBED_BYTES)) as Record<string, unknown>
  const title = cleanText(record.title, 160)
  if (!title) throw new Error("YouTube oEmbed metadata missing")
  const siteName = cleanText(record.provider_name, 80) ?? "YouTube"
  const authorName = cleanText(record.author_name, 80)
  const thumbnailSource = cleanThumbnailSource(record.thumbnail_url, original)
  return {
    url: original.href,
    hostname: original.hostname,
    title,
    siteName,
    ...(authorName ? { description: authorName } : {}),
    ...(thumbnailSource ? { thumbnailSource } : {}),
  }
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
  for (let redirects = 0; ; redirects += 1) {
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
}

/**
 * Fetch one public page within a single hard budget and return sanitized text
 * plus an internal, revalidated image candidate. The caller must never expose
 * thumbnailSource; it is only input to the same-origin thumbnail manifest.
 */
export async function fetchLinkPreview(input: string): Promise<FetchedLinkPreview> {
  const original = normalizePublicPreviewUrl(input)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  try {
    const youtubeId = youtubeVideoId(original)
    if (youtubeId) {
      return await fetchYouTubeOEmbed(original, youtubeId, controller.signal)
    }
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
        images: response.images.length > 0
          ? response.images
          : [doc("meta[name='twitter:image'],meta[property='twitter:image']").first().attr("content")]
              .filter((value): value is string => Boolean(value)),
      }),
    })
    const record = parsed as Record<string, unknown>
    const parsedTitle = cleanText(record.title, 160)
    const description = cleanText(record.description, 320)
    const siteName = cleanText(record.siteName, 80)
    const thumbnailSource = Array.isArray(record.images)
      ? cleanThumbnailSource(record.images[0], finalUrl)
      : undefined
    if (!parsedTitle && !description) throw new Error("preview metadata missing")
    const title = parsedTitle ?? siteName ?? original.hostname
    return {
      url: original.href,
      hostname: original.hostname,
      title,
      ...(description ? { description } : {}),
      ...(siteName ? { siteName } : {}),
      ...(thumbnailSource ? { thumbnailSource } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

export const LINK_PREVIEW_LIMITS = {
  maxHtmlBytes: MAX_HTML_BYTES,
  maxOEmbedBytes: MAX_OEMBED_BYTES,
  maxRedirects: MAX_REDIRECTS,
  timeoutMs: TOTAL_TIMEOUT_MS,
} as const
