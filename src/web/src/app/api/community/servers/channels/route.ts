import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import type { CommunityCliChannelGroup as ChannelGroup } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { buildServerChannelGroups } from "@/lib/community/list-channels"

/**
 * GET /api/community/servers/channels — all-servers channel list, the
 * servers-COLLECTION-level read (Gener #392). This is the bot's `channel list`
 * with no `--server`: fan out across every server the bot is in and return one
 * flat `ChannelGroup[]` (grouped-by-category per server, in `listUserServers`
 * order). A cross-server aggregate has no single-`[id]` home, so it lives at the
 * collection level — NOT a floating top-level operation-named route (Melly
 * #393: 能嵌就嵌到底). The single-server read is the sibling `servers/[id]/channels`
 * GET.
 *
 * Bot-only (no human all-servers channel DTO — the web reads per-server via the
 * bootstrap tree). Human actor → lean 404. Per-server visibility comes from
 * `listChannelsForMember` inside `buildServerChannelGroups`, so private channels
 * the bot can't see never appear; there is no server the bot isn't a member of
 * in `listUserServers`, so no existence mask is needed here.
 */
export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  if (ctx.actor.kind !== "bot") {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const botUserId = ctx.actor.userId
  const db = getDb(ctx.env.DB)

  const servers = await queries.communityServer.listUserServers(db, botUserId)

  // Fan out per-server DB work in parallel — for a bot in N servers this stays
  // flat instead of paying N× the RTT a sequential per-server loop would.
  const perServer = await Promise.all(
    servers.map((server) => buildServerChannelGroups(db, server, botUserId)),
  )

  const groups: ChannelGroup[] = perServer.flat()
  return NextResponse.json({ groups })
})
