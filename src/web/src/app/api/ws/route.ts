import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createAuth } from "@/lib/auth"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const agentId = url.searchParams.get("agentId")
  if (!agentId) return new Response("agentId required", { status: 400 })

  const { env } = getCloudflareContext()
  const wsEnv = env as Env

  const auth = createAuth(wsEnv)
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return new Response("Unauthorized", { status: 401 })

  const userId = session.user.id
  const doUrl = new URL(request.url)
  doUrl.searchParams.set("userId", userId)
  const doRequest = new Request(doUrl.toString(), request)
  doRequest.headers.set("X-Authenticated-User", userId)
  return wsEnv.WS_DO_WORKER.fetch(doRequest)
}
