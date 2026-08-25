export type LinkPreview = {
  url: string
  hostname: string
  title: string
  description?: string
  siteName?: string
}

const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PROSE_RE = /[.,!?;:'"\)\]\}]+$/
const INVITE_PATH_RE = /^\/c\/invite\/[A-Za-z0-9_-]{6,64}\/?$/

/**
 * Returns at most one ordinary public-web URL for a message preview. The raw
 * message remains untouched; this is only a cheap selector for the lazy card.
 * Alook invite URLs keep their dedicated action card and are skipped here.
 */
export function extractLinkPreviewUrl(text: string): string | null {
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const candidate = match[0]?.replace(TRAILING_PROSE_RE, "")
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (url.protocol !== "http:" && url.protocol !== "https:") continue
      if (INVITE_PATH_RE.test(url.pathname)) continue
      url.hash = ""
      return url.href
    } catch {
      // Keep scanning: malformed prose before a valid URL must not suppress it.
    }
  }
  return null
}
