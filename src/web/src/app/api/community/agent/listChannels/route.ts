import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentListChannelsRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

/**
 * POST /api/community/agent/listChannels — plan §7. Body `{ server? }`
 * (`server` is a bare `ServerId`, not a name — omit to list across every
 * server the bot is in). Top-level channels only (`listChannelsForMember`
 * filters `parentChannelId IS NULL`, mirroring `listServerChannels`) — same
 * visibility rule a human server-channels route uses, no extra
 * private-category filter on read (decided plan §7 v3).
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

  const serverIds = parsed.data.server
    ? [parsed.data.server]
    : (await queries.communityServer.listUserServers(db, ctx.botUserId)).map((s) => s.id)

  const channelsByServer = await Promise.all(
    serverIds.map((serverId) => queries.communityChannel.listChannelsForMember(db, serverId, ctx.botUserId))
  )

  const channels = channelsByServer.flat().map((c) => ({
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    kind: "channel" as const,
  }))

  return NextResponse.json({ channels })
})
