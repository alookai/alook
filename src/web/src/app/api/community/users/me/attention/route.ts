import { withAuth } from "@/lib/middleware/auth-policy"
import {
  AccountAttentionSnapshotSchema,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  queries,
  readOrStale,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { hydrateAttentionResources } from "@/lib/community/attention-resources.server"
import { parseBoundedInt } from "@/lib/community/messages"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(humanAuthPolicy, async (request, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const url = new URL(request.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )
  const { value, stale } = await readOrStale(
    async () => hydrateAttentionResources(db, ctx.userId, await queries.communityAttention.getAccountAttentionProjection(db, ctx.userId, limit)),
    {
      resources: { viewerId: ctx.userId, servers: [], serverMemberships: [], channels: [], memberships: [], profiles: [], messages: [] },
      scopes: [],
      items: [],
      limit,
      truncated: false,
      included: {
        servers: [],
        channels: [],
        dms: [],
        profiles: [],
        messages: [],
      },
    },
    { route: "community/attention" },
  )
  if (stale) return writeJSON({ ...value, stale: true })
  return writeJSON(AccountAttentionSnapshotSchema.parse(value))
})
