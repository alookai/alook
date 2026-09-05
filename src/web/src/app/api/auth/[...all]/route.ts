import { NextRequest } from "next/server"
import { toNextJsHandler } from "better-auth/next-js"
import { createAuth } from "@/lib/auth"
import { withEnv } from "@/lib/middleware/env"
import { nativeOauthSecurityHeaders } from "@/lib/native-oauth"

const SERVER_ONLY_AUTH_PREFIX = "/api/auth/one-time-token"

function isServerOnlyAuthRequest(request: NextRequest): boolean {
  const pathname = request.nextUrl.pathname.replace(/\/+$/, "")
  return pathname === SERVER_ONLY_AUTH_PREFIX
    || pathname.startsWith(`${SERVER_ONLY_AUTH_PREFIX}/`)
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: nativeOauthSecurityHeaders,
  })
}

export const GET = withEnv(async (req: NextRequest, ctx) => {
  if (isServerOnlyAuthRequest(req)) return notFound()
  return toNextJsHandler(createAuth(ctx.env)).GET(req)
});

export const POST = withEnv(async (req: NextRequest, ctx) => {
  if (isServerOnlyAuthRequest(req)) return notFound()
  return toNextJsHandler(createAuth(ctx.env)).POST(req)
});
