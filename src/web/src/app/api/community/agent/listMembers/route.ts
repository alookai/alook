import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentListMembersRequestSchema, formatHandle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

/**
 * POST /api/community/agent/listMembers — `alook server member --server <id-or-name>`.
 * Body `{ server }`. `server` accepts either the server id or its name (never
 * id-only, never name-only) — reuses `resolveServerByNameForMember`'s existing
 * id-then-name resolution, scoped to the bot's own membership.
 *
 * Ambiguous name matches (2+ servers) are NOT surfaced via a separate `hint`
 * field — the candidate ids/names are baked directly into the `error` string,
 * since there is no structured-hint consumer on the CLI side (see plan's
 * "hint stays a plain string" design note).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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

  const servers = await queries.communityServer.resolveServerByNameForMember(db, ctx.botUserId, parsed.data.server)
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

  const rows = await queries.communityMember.listMembers(db, serverId)
  const members = rows.map((r) => ({
    handle: formatHandle(r.userName ?? "", r.discriminator ?? "0000"),
    role: r.role ?? "member",
    ...(r.nickname ? { nickname: r.nickname } : {}),
  }))

  return NextResponse.json({ members })
})
