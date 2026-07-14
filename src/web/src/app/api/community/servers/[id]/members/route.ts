import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt, parseMemberCursor, buildMemberPaginatedResponse } from "@/lib/community/messages"
import { mapMemberForApi } from "@/lib/community/member-payload"

export const GET = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_MEMBERS_PAGE_SIZE,
    MAX_MEMBERS_PAGE_SIZE,
  )
  const cursor = parseMemberCursor(url.searchParams.get("cursor"))

  // Fetch page + total in parallel — total is returned in the envelope so the
  // settings tab (SettingsMembers) can show the real member count without a
  // second round-trip to /members/count.
  const [page, total] = await Promise.all([
    queries.communityMember.listMembersPaginated(db, serverId, { cursor, limit }),
    queries.communityMember.countMembers(db, serverId),
  ])

  // Build the cursor string from the raw page rows (which carry joinedAt)
  // BEFORE stripping down to the display shape — the Member type on the
  // client has no joinedAt field and shouldn't gain one.
  const envelope = buildMemberPaginatedResponse(page.members, page.hasMore)

  // Owner-scoped isBot/ownerUserId projection (via the shared mapper's
  // `botGating` opt): the caller sees `isBot`/`ownerUserId` ONLY on rows they
  // own; other bots appear as normal humans. This is the load-bearing
  // pass-as-human projection at the member-list layer.
  const members = envelope.members.map((r) =>
    mapMemberForApi(r, ctx.userId, { botGating: true }),
  )

  return writeJSON({ members, hasMore: envelope.hasMore, cursor: envelope.cursor, limit, total })
})
