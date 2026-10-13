import { NextRequest } from "next/server"
import { getAuth } from "@/lib/auth"
import { DEV_WS_DO_URL } from "@alook/shared"
import { withEnv } from "@/lib/middleware/env"

export const GET = withEnv(async (req: NextRequest, ctx) => {
  const auth = getAuth(ctx.env)
  const authResponse = await auth.api.getSession({
    headers: req.headers,
    asResponse: true,
    ...(req.nextUrl.searchParams.get("refresh") === "1" && { query: { disableCookieCache: true } }),
  })
  if (!authResponse.ok) return authResponse
  const session = await authResponse.json() as typeof auth.$Infer.Session | null
  if (!session) {
    const response = new Response("Unauthorized", { status: 401 })
    for (const cookie of authResponse.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie)
    return response
  }

  const wsDoUrl = (ctx.env as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined
  let wsPort: number | undefined
  try {
    wsPort = new URL(wsDoUrl || DEV_WS_DO_URL).port ? Number(new URL(wsDoUrl || DEV_WS_DO_URL).port) : undefined
  } catch {}

  const response = Response.json({
    userId: session.user.id,
    token: session.session.token,
    ...(wsPort && { wsPort }),
  })
  for (const cookie of authResponse.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie)
  return response
});
