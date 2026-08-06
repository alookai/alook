import { NextResponse, NextRequest } from "next/server"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { buildServerChannelGroups } from "@/lib/community/list-channels"

/**
 * GET /api/community/servers/[id]/channels — single-server channel list, bot
 * arm of the folded `listChannels` verb (route/disc trunk, 接口树统一 轴3). The
 * bot addresses by `?server=<ref>` (id OR display name); the all-servers mode
 * (bot omitting `server`) lives at the servers-collection route `GET
 * servers/channels` instead — a cross-server aggregate has no single-`[id]`
 * home. Human web reads the channel tree via the server bootstrap, so this GET
 * is bot-only today; a human actor gets a lean 404 (no human channel-list DTO
 * to project — the human read simply isn't this door).
 *
 * ①-C existence mask: `resolveServerByNameForMember` is member-scoped, so a
 * server the bot isn't in returns zero matches → 404 (indistinguishable from a
 * nonexistent server). `buildServerChannelGroups` runs `listChannelsForMember`
 * so private-category channels the bot can't see never appear.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  if (ctx.actor.kind !== "bot") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const botUserId = ctx.actor.userId
  const db = getDb(ctx.env.DB)

  const serverRef = new URL(req.url).searchParams.get("server")
  if (!serverRef) {
    return NextResponse.json({ error: "missing server query param" }, { status: 400 })
  }

  const servers = await queries.communityServer.resolveServerByNameForMember(db, botUserId, serverRef)
  if (servers.length === 0) {
    return NextResponse.json({ error: `server not found: ${serverRef}` }, { status: 404 })
  }
  if (servers.length > 1) {
    const candidates = servers.map((s) => `${s.id} ("${s.name}")`).join(", ")
    return NextResponse.json(
      { error: `ambiguous server name "${serverRef}" — matches ${servers.length} servers: ${candidates}` },
      { status: 400 },
    )
  }

  const groups = await buildServerChannelGroups(db, servers[0]!, botUserId)
  return NextResponse.json({ groups })
})
