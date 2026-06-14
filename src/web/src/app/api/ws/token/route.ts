import { NextRequest } from "next/server"
import { createAuth } from "@/lib/auth"
import { DEV_WS_DO_URL } from "@alook/shared"
import { withEnv } from "@/lib/middleware/env"

export const GET = withEnv(async (req: NextRequest, ctx) => {
  const auth = createAuth(ctx.env)
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session) return new Response("Unauthorized", { status: 401 })

  const wsDoUrl = (ctx.env as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined
  let wsPort: number | undefined
  try {
    wsPort = new URL(wsDoUrl || DEV_WS_DO_URL).port ? Number(new URL(wsDoUrl || DEV_WS_DO_URL).port) : undefined
  } catch {}

  return Response.json({
    userId: session.user.id,
    token: session.session.token,
    ...(wsPort && { wsPort }),
  })
});
