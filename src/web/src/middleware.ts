import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getAuth } from "@/lib/auth"
import { safeRedirectPath } from "@/lib/safe-redirect"
import { isRetiredWorkspacePath } from "@/lib/retired-workspace"

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
  const retired = isRetiredWorkspacePath(pathname)
  const needsAuth = !isPublic && (retired || pathname === "/c" || AUTH_REQUIRED_PREFIXES.some((p) => pathname.startsWith(p)))

  if (needsAuth) {
    const { env } = await getCloudflareContext({ async: true })
    const auth = getAuth(env as Env)
    const result = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as { headers: Headers; response: unknown } | null

    if (!result?.response) {
      const signInUrl = new URL("/sign-in", request.url)
      const returnTo = retired ? "/c/me" : pathname + request.nextUrl.search
      if (returnTo !== "/workspaces") {
        signInUrl.searchParams.set("redirect", returnTo)
      }
      return NextResponse.redirect(signInUrl)
    }

    const res = retired ? NextResponse.redirect(new URL("/c/me", request.url)) : NextResponse.next()
    for (const cookie of result.headers.getSetCookie()) {
      res.headers.append("Set-Cookie", cookie)
    }
    return res
  }

  if (pathname === "/sign-in" || pathname === "/sign-up") {
    const { env } = await getCloudflareContext({ async: true })
    const auth = getAuth(env as Env)
    const result = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    }) as { headers: Headers; response: unknown } | null

    if (result?.response) {
      const redirect = request.nextUrl.searchParams.get("redirect")
      const target = new URL(safeRedirectPath(redirect), request.url)
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
  matcher: ["/w/:path*", "/((?!_next|favicon\\.ico|.*\\..*).*)"],
}
