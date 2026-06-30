import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, DEV_WS_DO_URL, PRESENCE_MEMBER_CAP } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Cap the fan-out: a 10k-member server would otherwise spawn 10k Worker
  // subrequests and time out. Client paginates if it needs more.
  const members = await queries.communityMember.listMembers(db, serverId)
  const truncated = members.length > PRESENCE_MEMBER_CAP
  const userIds = members.slice(0, PRESENCE_MEMBER_CAP).map((m) => m.userId)

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
    }),
  )

  return writeJSON({ online, truncated, limit: PRESENCE_MEMBER_CAP })
})
