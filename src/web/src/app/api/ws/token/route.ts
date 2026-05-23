import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createAuth } from "@/lib/auth"
import { DEV_WS_DO_URL } from "@alook/shared"

export async function GET(request: Request) {
  const { env } = getCloudflareContext()
  const auth = createAuth(env as Env)
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return new Response("Unauthorized", { status: 401 })

  const wsDoUrl = (env as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined
  let wsPort: number | undefined
  try {
    wsPort = new URL(wsDoUrl || DEV_WS_DO_URL).port ? Number(new URL(wsDoUrl || DEV_WS_DO_URL).port) : undefined
  } catch {}

  return Response.json({
    userId: session.user.id,
    token: session.session.token,
    ...(wsPort && { wsPort }),
  })
}
