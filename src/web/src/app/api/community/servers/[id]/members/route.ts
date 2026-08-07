import { NextResponse, type NextRequest } from "next/server"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  formatHandle,
  parseNameAndTag,
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt, parseMemberCursor, buildMemberPaginatedResponse } from "@/lib/community/messages"
import { mapMemberForApi } from "@/lib/community/member-payload"
import { fetchOnlineUserIds, toMemberStatus } from "@/lib/community/member-presence"

/**
 * GET /api/community/servers/[id]/members — dual-actor server-member list
 * (route/disc trunk, 接口树统一 轴3). Folds the flat bot `listMembers` verb into
 * this canonical server-scoped collection: human addresses by `[id]` path, bot
 * addresses by `?server=<ref>` (id OR display name), both converge on one
 * serverId and one member read. Type/caller is data, not a separate route.
 *
 * Two projections off actor.kind (Fork-C): human = full UI DTO (paginated,
 * owner-scoped isBot/ownerUserId via `mapMemberForApi` botGating) ; bot = lean
 * `{handle, role, online, status}` (no internal ids), also PAGINATED (stable
 * keyset cursor, `hasMore`/`cursor` on the wire) — the roster is a whole-server
 * audience and potentially unbounded, unlike a channel/thread roster.
 *
 * ①-C existence mask: the bot's `resolveServerByNameForMember` is member-scoped,
 * so a server the bot isn't in returns zero matches → 404 "server not found"
 * (indistinguishable from a truly nonexistent server — no existence leak). The
 * human arm keeps `requireServerMember`'s own 403/404.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "bot") {
    return handleBotList(req, ctx.env, db, ctx.actor.userId)
  }
  return handleHumanList(req, db, ctx.actor.userId, ctx.params?.id)
})

async function handleBotList(
  req: NextRequest,
  env: Env,
  db: ReturnType<typeof getDb>,
  botUserId: string,
): Promise<NextResponse> {
  const url = new URL(req.url)
  const serverRef = url.searchParams.get("server")
  if (!serverRef) {
    return NextResponse.json({ error: "missing server query param" }, { status: 400 })
  }
  if (!parseNameAndTag(serverRef)) {
    return NextResponse.json({ error: "invalid server handle, expected name#0042" }, { status: 400 })
  }

  const servers = await queries.communityServer.resolveServerByNameForMember(db, botUserId, serverRef)
  if (servers.length === 0) {
    return NextResponse.json({ error: `server not found: ${serverRef}` }, { status: 404 })
  }
  const serverId = servers[0]!.id

  // Forward-paginated roster (opaque `joinedAt|id` cursor) — same as the human
  // arm; the server roster is potentially unbounded so unlike a channel/thread
  // roster it must page.
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_MEMBERS_PAGE_SIZE,
    MAX_MEMBERS_PAGE_SIZE,
  )
  const cursor = parseMemberCursor(url.searchParams.get("cursor"))
  const page = await queries.communityMember.listMembersPaginated(db, serverId, { cursor, limit })

  // Bulk presence for THIS page's user ids only (bounded) — never per-member.
  const onlineSet = await fetchOnlineUserIds(env, page.members.map((r) => r.userId), serverId)

  const members = page.members.map((r) => ({
    handle: formatHandle(r.userName ?? "", r.discriminator ?? "0000"),
    role: r.role ?? "member",
    online: onlineSet.has(r.userId),
    status: toMemberStatus(r),
  }))

  const cursorOut = page.cursor ? `${page.cursor.joinedAt}|${page.cursor.id}` : undefined

  return NextResponse.json({ members, hasMore: page.hasMore, cursor: cursorOut })
}

async function handleHumanList(
  req: NextRequest,
  db: ReturnType<typeof getDb>,
  userId: string,
  serverId: string | undefined,
): Promise<NextResponse> {
  if (!serverId) return writeError("missing server id", 400)

  const auth = await requireServerMember(db, serverId, userId)
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
    mapMemberForApi(r, userId, { botGating: true }),
  )

  return writeJSON({ members, hasMore: envelope.hasMore, cursor: envelope.cursor, limit, total })
}
