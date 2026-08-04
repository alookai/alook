import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  CommunityAgentListMembersRequestSchema,
  formatHandle,
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "@alook/shared"
import type { CommunityCliServerMemberListResult as ServerMemberListResult } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { parseMemberCursor } from "@/lib/community/messages"
import { fetchOnlineUserIds, toMemberStatus } from "@/lib/community/member-presence"

/**
 * POST /api/community/listMembers — moved from /api/community/agent/listMembers
 * (plan §4 MOVE-FLAT, §9 phase 4). `alook server member --server <id-or-name>`.
 * Body `{ server }` — id OR name, resolved via `resolveServerByNameForMember`.
 * Ref/name-addressed → can't fold onto the `[id]`-param human
 * servers/[id]/members route (Fork B): the bot addresses by name, the CLI
 * can't form the `[id]` URL. Lean handle shape `{handle, role}` (distinct from
 * the human members route's full UI DTO). Bot-only → human actor 403. Body
 * unchanged from the /agent original except wrapper + identity source.
 *
 * Ambiguous name matches (2+ servers) bake the candidate ids/names into the
 * `error` string (no structured-hint consumer on the CLI side).
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentListMembersRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }

  const servers = await queries.communityServer.resolveServerByNameForMember(db, botUserId, parsed.data.server)
  if (servers.length === 0) {
    return NextResponse.json({ error: `server not found: ${parsed.data.server}` }, { status: 404 })
  }
  if (servers.length > 1) {
    const candidates = servers.map((s) => `${s.id} ("${s.name}")`).join(", ")
    return NextResponse.json(
      { error: `ambiguous server name "${parsed.data.server}" — matches ${servers.length} servers: ${candidates}` },
      { status: 400 },
    )
  }
  const serverId = servers[0]!.id

  // Forward-paginated roster (opaque `joinedAt|id` cursor). The server roster is
  // the whole-server audience — potentially unbounded — so unlike private
  // channel/thread rosters it must page. limit is clamped to DEFAULT/MAX.
  const limit = Math.min(
    Math.max(parsed.data.limit ?? DEFAULT_MEMBERS_PAGE_SIZE, 1),
    MAX_MEMBERS_PAGE_SIZE,
  )
  const cursor = parseMemberCursor(parsed.data.cursor ?? null)
  const page = await queries.communityMember.listMembersPaginated(db, serverId, { cursor, limit })

  // Bulk presence for THIS page's user ids only (bounded) — never per-member.
  const onlineSet = await fetchOnlineUserIds(
    ctx.env,
    page.members.map((r) => r.userId),
    serverId,
  )

  const members = page.members.map((r) => ({
    handle: formatHandle(r.userName ?? "", r.discriminator ?? "0000"),
    role: r.role ?? "member",
    online: onlineSet.has(r.userId),
    status: toMemberStatus(r),
  }))

  // listMembersPaginated already computed the next-page keyset (present iff
  // hasMore); serialize it to the opaque `joinedAt|id` wire cursor.
  const cursorOut = page.cursor ? `${page.cursor.joinedAt}|${page.cursor.id}` : undefined

  return NextResponse.json<ServerMemberListResult>({
    members,
    hasMore: page.hasMore,
    cursor: cursorOut,
  })
})
