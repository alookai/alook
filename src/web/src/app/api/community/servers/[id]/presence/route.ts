import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, DEV_WS_DO_URL } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  const members = await queries.communityMember.listMembers(db, serverId)
  const userIds = members.map((m) => m.userId)

  // Check each member's presence via the ws-do worker
  const online: string[] = []
  await Promise.allSettled(
    userIds.map(async (userId) => {
      try {
        let resp: Response
        try {
          const { env } = getCloudflareContext()
          resp = await (env as Env).WS_DO_WORKER.fetch(`http://internal/presence/user/${userId}`)
        } catch {
          const wsDoUrl = (ctx.env as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined
          const base = wsDoUrl || DEV_WS_DO_URL
          resp = await fetch(`${base}/presence/user/${userId}`)
        }
        if (resp.ok) {
          const data = await resp.json() as { online: boolean }
          if (data.online) online.push(userId)
        }
      } catch { /* skip */ }
    })
  )

  return writeJSON({ online })
})
