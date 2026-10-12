import { isTauri } from "@alook/shared"

export function ensureBrowserAnalyticsIdentity() {
  if (typeof document === "undefined" || typeof window === "undefined" || isTauri()) return
  const cookie = document.cookie.match(/(?:^|;\s*)_ga=([^;]*)/u)?.[1]
  if (cookie && /^GA\d+\.\d+\.\d{1,20}\.\d{1,20}$/u.test(cookie)) return
  const random = crypto.getRandomValues(new Uint32Array(2))
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `_ga=GA1.1.${random[0]}.${random[1]}; Path=/; Max-Age=15552000; SameSite=Lax${secure}`
}
