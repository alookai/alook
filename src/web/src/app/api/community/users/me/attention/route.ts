import {
  AccountAttentionSnapshotSchema,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  queries,
  readOrStale,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { avatarInitial } from "@/lib/community/avatar"
import { parseBoundedInt } from "@/lib/community/messages"
import { canonicalUserImage } from "@/lib/community/storage"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

function canonicalizeIncludedAvatar<T extends {
  userId: string
  name: string
  avatar: string
  avatarVersion: number
}>(row: T): T {
  return {
    ...row,
    avatar: canonicalUserImage(row.userId, row.avatar, row.avatarVersion)
      ?? avatarInitial(row.name),
  }
}

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
  const normalized = {
    ...value,
    included: {
      ...value.included,
      dms: value.included.dms.map(canonicalizeIncludedAvatar),
      profiles: value.included.profiles.map(canonicalizeIncludedAvatar),
    },
  }
  if (stale) return writeJSON({ ...normalized, stale: true })
  return writeJSON(AccountAttentionSnapshotSchema.parse(normalized))
})
