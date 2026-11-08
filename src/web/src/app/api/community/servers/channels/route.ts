import { withAuth } from "@/lib/middleware/auth-policy"
import { NextResponse, type NextRequest } from "next/server"
import { queries, formatHandle, isServerOwner } from "@alook/shared"
import type { CommunityCliChannelGroup as ChannelGroup } from "@alook/shared"
import { getDb } from "@/lib/db"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { serverIconUrl } from "@/lib/community/storage"
import { buildServerChannelGroups } from "@/lib/community/list-channels"

/**
 * The bot aggregate includes only joined servers and visible channels.
 * Human callers use per-server reads and receive404 here.
 */
export const GET = withAuth(communityActorPolicy({ allowInactiveBot: true }), async (_req: NextRequest, ctx) => {
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
  return NextResponse.json({ groups, servers: servers.map((server) => ({ id: server.id, name: server.name, handle: formatHandle(server.name, server.discriminator), icon: serverIconUrl(server), canLeave: !isServerOwner(server.role) })) })
})
