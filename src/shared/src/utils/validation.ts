
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function isValidEmail(e: string) { return EMAIL_RE.test(e) }
