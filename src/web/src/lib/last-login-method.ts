export const LAST_LOGIN_METHOD_COOKIE = "alook_last_login_method"
export const LAST_LOGIN_METHOD_MAX_AGE = 60 * 60 * 24 * 30

export type LoginMethod = "github" | "google" | "apple" | "email"

export function normalizeLoginMethod(value: string | null | undefined): LoginMethod | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "github" || normalized === "google" || normalized === "apple") {
    return normalized
  }
  if (normalized === "email" || normalized === "email-otp" || normalized === "email_otp") {
    return "email"
  }
  return null
}

export function resolveAuthPathLoginMethod(path: string | null | undefined): LoginMethod | null {
  if (!path) return null
  if (path.startsWith("/callback/")) {
    return normalizeLoginMethod(path.slice("/callback/".length).split("/")[0])
  }
  if (
    path === "/sign-in/email"
    || path === "/sign-up/email"
    || path === "/sign-in/email-otp"
  ) {
    return "email"
  }
  return null
}

export function formatLastLoginMethodSetCookie(method: LoginMethod, secure: boolean): string {
  return `${LAST_LOGIN_METHOD_COOKIE}=${method}; Max-Age=${LAST_LOGIN_METHOD_MAX_AGE}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`
}

export function rememberLastLoginMethod(method: LoginMethod): void {
  if (typeof document === "undefined") return
  const secure = typeof window !== "undefined" && window.location?.protocol === "https:"
  document.cookie = formatLastLoginMethodSetCookie(method, secure)
}
