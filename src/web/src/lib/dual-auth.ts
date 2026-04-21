import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"

export async function requireAuth(request: Request) {
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as Env

  const authHeader = request.headers.get("Authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const raw = authHeader.slice(7)
    if (raw.startsWith("al_")) {
      const db = getDb(cloudflareEnv.DB)
      const mt = await queries.machineToken.getMachineTokenByToken(db, raw)
      if (mt) {
        queries.machineToken.updateMachineTokenLastUsed(db, mt.id).catch(() => {})
        return { userId: mt.userId, email: mt.userEmail, workspaceId: mt.workspaceId ?? undefined, error: null }
      }
    }
  }

  const auth = createAuth(cloudflareEnv)
  const session = await auth.api.getSession({ headers: request.headers })
  if (session) {
    return { userId: session.user.id, email: session.user.email, workspaceId: undefined, error: null }
  }

  return { userId: null, email: null, workspaceId: undefined, error: new Response("Unauthorized", { status: 401 }) }
}
