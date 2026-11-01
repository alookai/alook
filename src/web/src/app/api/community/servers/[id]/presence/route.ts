import { withAuth } from "@/lib/middleware/auth-policy"
import { queries, PRESENCE_MEMBER_CAP, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"
import { fetchUserPresence } from "@/lib/community/member-presence"

export const GET = withAuth(humanAuthPolicy, async (_req, ctx) => {
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
  const presence = stale ? undefined : await fetchUserPresence(ctx.env, value.userIds, serverId)
  return writeJSON({
    ...(presence ?? { online: [], offline: [] }),
    truncated: value.truncated, limit: PRESENCE_MEMBER_CAP,
    ...(!presence ? { stale: true } : {}),
  })
})
