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
  const needsAuth = pathname === "/c" || AUTH_REQUIRED_PREFIXES.some((p) => pathname.startsWith(p))

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
        : new URL("/workspaces?auto", request.url)
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
