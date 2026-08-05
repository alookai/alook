import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createAuth } from "@/lib/auth"

function isSafeRedirect(path: string): boolean {
  // Must be a relative path. Reject scheme-relative ("//evil.com") and
  // backslash tricks ("/\evil.com") — the WHATWG URL parser treats "\" as "/",
  // so both resolve to an external origin and would be an open redirect.
  return path.startsWith("/") && path[1] !== "/" && path[1] !== "\\"
}

const AUTH_REQUIRED_PREFIXES = ["/invite/", "/w/", "/workspaces", "/dashboard", "/c/"]

// Paths that stay public even though they'd otherwise match an auth-required
// prefix. The invite landing page is preview-first: a logged-out user must be
// able to SEE the invite (server name/icon/description/members) and only hit
// the login wall when they click Join. Its `info` API is `withOptionalAuth`
// and the invite token is the capability, so serving the page anonymously
// leaks nothing gated. Scoped to exactly this path — the rest of `/c/` stays
// gated.
const PUBLIC_PREFIXES = ["/c/invite/"]

export async function middleware(request: NextRequest) {
  if (
    request.headers.get("x-forwarded-proto") === "http" &&
    !request.nextUrl.hostname.startsWith("localhost") &&
    !request.nextUrl.hostname.startsWith("127.")
  ) {
    const httpsUrl = request.nextUrl.clone()
    httpsUrl.protocol = "https:"
    return NextResponse.redirect(httpsUrl, 301)
  }

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  const needsAuth = !isPublic && (pathname === "/c" || AUTH_REQUIRED_PREFIXES.some((p) => pathname.startsWith(p)))

  if (needsAuth) {
    const { env } = await getCloudflareContext({ async: true })
    const auth = createAuth(env as Env)
    const result = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as { headers: Headers; response: unknown } | null

    if (!result?.response) {
      const signInUrl = new URL("/sign-in", request.url)
      const returnTo = pathname + request.nextUrl.search
      if (returnTo !== "/workspaces") {
        signInUrl.searchParams.set("redirect", returnTo)
      }
      return NextResponse.redirect(signInUrl)
    }

    const res = NextResponse.next()
    for (const cookie of result.headers.getSetCookie()) {
      res.headers.append("Set-Cookie", cookie)
    }
    return res
  }

  if (pathname === "/sign-in" || pathname === "/sign-up") {
    const { env } = await getCloudflareContext({ async: true })
    const auth = createAuth(env as Env)
    const result = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as { headers: Headers; response: unknown } | null

    if (result?.response) {
      const redirect = request.nextUrl.searchParams.get("redirect")
      const target = redirect && isSafeRedirect(redirect)
        ? new URL(redirect, request.url)
        // Default landing for an already-signed-in visitor hitting /sign-in:
        // community home. `/workspaces` was the retired legacy (v0) surface.
        : new URL("/c/me", request.url)
      const res = NextResponse.redirect(target)
      for (const cookie of result.headers.getSetCookie()) {
        res.headers.append("Set-Cookie", cookie)
      }
      return res
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
}
