const DOMAIN = `@${process.env.ALOOK_DOMAIN || "alook.ai"}`
const HANDLE_RE = /^[a-zA-Z0-9-]{3,}$/
export function parseEmailHandle(a: string) { return a.endsWith(DOMAIN) ? a.slice(0, -DOMAIN.length) : "" }
export function toAlookAddress(h: string) { return `${h}${DOMAIN}` }
export function isValidHandle(h: string) { return HANDLE_RE.test(h) }
