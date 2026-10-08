import { NextRequest, NextResponse } from "next/server"
import { applySetCookies, parseSetCookieHeader } from "better-auth/cookies"

export function authResponseCookies(request: NextRequest, headers: Headers) {
  const setCookies = headers.getSetCookie()
  if (!setCookies.length) return NextResponse.next()
  const forwardedHeaders = new Headers(request.headers)
  applySetCookies(forwardedHeaders, setCookies)
  const forwarded = new NextRequest(request.url, { headers: forwardedHeaders })
  for (const [name, cookie] of parseSetCookieHeader(setCookies.join(", "))) {
    if (cookie["max-age"] !== undefined ? cookie["max-age"] <= 0 : cookie.expires && cookie.expires.getTime() <= Date.now()) {
      forwarded.cookies.delete(name)
    }
  }
  const response = NextResponse.next({ request: { headers: forwarded.headers } })
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie)
  return response
}
