import { queries, PRESENCE_MEMBER_CAP, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"
import { wsDoFetch } from "@/lib/broadcast"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Cap the fan-out: a 10k-member server would otherwise spawn 10k Worker
  // subrequests and time out. Client paginates if it needs more.
  const { value, stale } = await readOrStale<{ userIds: string[]; truncated: boolean }>(
    async () => {
      const allUserIds = await queries.communityMember.listMemberUserIds(db, serverId)
      return {
        userIds: allUserIds.slice(0, PRESENCE_MEMBER_CAP),
        truncated: allUserIds.length > PRESENCE_MEMBER_CAP,
      }
    },
    { userIds: [], truncated: false },
    { route: "community/servers/presence" },
  )

  // Single subrequest — the ws-do worker fans out to each member's DO
  // internally, keeping the web-worker subrequest budget constant.
  let online: string[] = []
  if (!stale && value.userIds.length > 0) {
    const body = JSON.stringify({ ids: value.userIds })
    try {
      const resp = await wsDoFetch(ctx.env, "/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }, { label: serverId })
      if (resp.ok) {
        const data = await resp.json() as { online: string[] }
        online = Array.isArray(data.online) ? data.online : []
      }
    } catch { /* skip */ }
  }

  const payload = { online, truncated: value.truncated, limit: PRESENCE_MEMBER_CAP }
  return writeJSON(stale ? { ...payload, stale: true } : payload)
})
