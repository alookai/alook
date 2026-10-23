import { NextRequest, NextResponse } from "next/server"
import { safeRedirectPath } from "@/lib/safe-redirect"

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
  if (pathname === "/sign-in" || pathname === "/sign-up") {
    const [{ getCloudflareContext }, { getAuth, observeAuthSession }] = await Promise.all([
      import("@opennextjs/cloudflare"), import("@/lib/auth"),
    ])
    const { env } = await getCloudflareContext({ async: true })
    const auth = getAuth(env as Env)
    const result = await observeAuthSession(auth, () => auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    })) as { headers: Headers; response: unknown } | null

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
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
}
