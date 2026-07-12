import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentListChannelsRequestSchema, formatRef } from "@alook/shared"
import type { ChannelListItem } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

/**
 * POST /api/community/agent/listChannels — `alook channel list`. Body
 * `{ server? }` — `server` accepts either the server's id or its display
 * name (resolved via `resolveServerByNameForMember`, same helper
 * `listMembers` uses), or omit to list across every server the bot is in.
 * Top-level channels only (`listChannelsForMember` filters
 * `parentChannelId IS NULL`, mirroring `listServerChannels`) — same
 * visibility rule a human sees: private-category channels appear only when the
 * bot is an admin, the channel's creator, or an added member.
 *
 * Response items are `{ ref, name, type }` (plan §Decisions #12) — `ref` is
 * directly reusable as `--channel`/`--target` on every other command, and
 * `type` (`"text"`/`"forum"`) comes straight off `listChannelsForMember`'s
 * row.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown = {}
  try {
    const text = await req.text()
    if (text) raw = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentListChannelsRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }

  let servers: Array<{ id: string; name: string }>
  if (parsed.data.server) {
    servers = await queries.communityServer.resolveServerByNameForMember(db, ctx.botUserId, parsed.data.server)
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
  } else {
    servers = await queries.communityServer.listUserServers(db, ctx.botUserId)
  }

  const channelsByServer = await Promise.all(
    servers.map(async (s) => ({
      server: s,
      rows: await queries.communityChannel.listChannelsForMember(db, s.id, ctx.botUserId),
    }))
  )

  const channels: ChannelListItem[] = channelsByServer.flatMap(({ server, rows }) =>
    rows.map((c) => ({
      ref: formatRef({ server: server.name, channel: c.name }),
      name: c.name,
      type: c.type,
    }))
  )

  return NextResponse.json({ channels })
})
