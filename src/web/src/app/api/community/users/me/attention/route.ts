import {
  AccountAttentionSnapshotSchema,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  queries,
  readOrStale,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { parseBoundedInt } from "@/lib/community/messages"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (request, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const url = new URL(request.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )
  const { value, stale } = await readOrStale(
    () => queries.communityAttention.getAccountAttentionSnapshot(db, ctx.userId, limit),
    {
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
