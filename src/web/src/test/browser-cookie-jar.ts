import { NextRequest } from "next/server"
import { parseSetCookieHeader } from "better-auth/cookies"

// Apply response cookies between same-origin browser fixture requests.
export function browserCookieHeaders(headers: Headers, responseHeaders: Headers) {
  const request = new NextRequest("https://fixture.test", { headers })
  for (const raw of responseHeaders.getSetCookie()) {
    for (const [name, cookie] of parseSetCookieHeader(raw)) {
      const maxAge = cookie["max-age"]
      const expired = typeof maxAge === "number" && Number.isFinite(maxAge)
        ? maxAge <= 0
        : cookie.expires !== undefined && cookie.expires.getTime() <= Date.now()
      if (expired) request.cookies.delete(name)
      else request.cookies.set(name, cookie.value)
    }
  }
  return request.headers
}
