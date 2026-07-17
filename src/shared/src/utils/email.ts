import { SENSITIVE_RECIPIENT_DOMAINS } from "../constants"

const DOMAIN = `@${process.env.ALOOK_DOMAIN || "alook.ai"}`
const HANDLE_RE = /^[a-zA-Z0-9-]{3,}$/

const RESERVED_HANDLES = new Set([
  "no-reply",
  "noreply",
  "admin",
  "support",
  "help",
  "info",
  "postmaster",
  "abuse",
  "security",
  "mailer-daemon",
  "root",
  "webmaster",
  "hostmaster",
  "system",
  "alook",
])

export function parseEmailHandle(a: string) { return a.endsWith(DOMAIN) ? a.slice(0, -DOMAIN.length) : "" }
export function toAlookAddress(h: string) { return `${h}${DOMAIN}` }
export function isValidHandle(h: string) { return HANDLE_RE.test(h) && !RESERVED_HANDLES.has(h.toLowerCase()) }

export function extractDomain(email: string): string | null {
  if (!email) return null
  const angleMatch = email.match(/<([^<>]*)>[^<>]*$/)
  const addr = (angleMatch ? angleMatch[1] : email).trim()
  const at = addr.lastIndexOf("@")
  if (at < 0) return null
  const domain = addr.slice(at + 1).trim().toLowerCase()
  return domain || null
}

export function isSensitiveRecipient(email: string): boolean {
  const domain = extractDomain(email)
  if (!domain) return false
  return SENSITIVE_RECIPIENT_DOMAINS.some((entry) => {
    const target = entry.toLowerCase()
    return domain === target || domain.endsWith(target)
  })
}
