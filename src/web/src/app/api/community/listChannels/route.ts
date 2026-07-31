import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentListChannelsRequestSchema, formatRef } from "@alook/shared"
import type {
  CommunityCliChannelGroup as ChannelGroup,
  ChannelListItem,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"

/**
 * POST /api/community/listChannels — moved from /api/community/agent/listChannels
 * (plan §4 MOVE-FLAT, §9 phase 4). `alook channel list`. Body `{ server? }` —
 * `server` accepts the server's id OR display name (resolved via
 * `resolveServerByNameForMember`), or omit to list across every server the bot
 * is in. Ref/name-addressed → can't fold onto an `[id]` route (Fork B); the
 * server channel-list also has no human GET twin (the web reads it via the
 * server bootstrap tree), so this is a clean MOVE. Bot-only → human actor 403.
 * Body unchanged from the /agent original except wrapper + identity source.
 *
 * Top-level channels only (`listChannelsForMember` filters
 * `parentChannelId IS NULL`) — same visibility rule a human sees. Response is
 * `{ groups: [{ category, channels: [{ref, name, type, visibility}] }] }`;
 * channels bucketed by `categoryId` (uncategorized first, then categories by
 * position). Empty groups dropped so a private-category name never leaks.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId

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
    servers = await queries.communityServer.resolveServerByNameForMember(db, botUserId, parsed.data.server)
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
    servers = await queries.communityServer.listUserServers(db, botUserId)
  }

  // Fan out per-server DB work in parallel — for a bot in N servers this
  // stays flat instead of paying N× the RTT that a sequential per-server
  // loop would.
  const perServer = await Promise.all(
    servers.map(async (server) => {
      const [rows, categories] = await Promise.all([
        queries.communityChannel.listChannelsForMember(db, server.id, botUserId),
        queries.communityCategory.listCategoriesByServer(db, server.id),
      ])

      const categoryById = new Map<string, { id: string; name: string; position: number | null; private: number | null }>()
      for (const c of categories) categoryById.set(c.id, c)

      const uncategorized: ChannelListItem[] = []
      const byCategory = new Map<string, ChannelListItem[]>()

      // rows come from `listChannelsForMember` already ordered by
      // `communityChannel.position asc`; bucket into groups preserving that
      // per-bucket order.
      for (const c of rows) {
        const cat = c.categoryId ? categoryById.get(c.categoryId) : null
        const isPrivate = !!(cat && (cat.private ?? 0) === 1)
        const item: ChannelListItem = {
          ref: formatRef({ server: server.name, channel: c.name }),
          id: c.id,
          serverId: server.id,
          name: c.name,
          type: c.type,
          visibility: isPrivate ? "private" : "public",
        }
        if (!c.categoryId || !cat) {
          uncategorized.push(item)
        } else {
          const bucket = byCategory.get(c.categoryId) ?? []
          bucket.push(item)
          byCategory.set(c.categoryId, bucket)
        }
      }

      const serverGroups: ChannelGroup[] = []
      if (uncategorized.length > 0) {
        serverGroups.push({ category: null, channels: uncategorized })
      }
      for (const cat of categories) {
        const items = byCategory.get(cat.id)
        if (!items || items.length === 0) continue
        serverGroups.push({
          category: { name: cat.name, private: (cat.private ?? 0) === 1 },
          channels: items,
        })
      }
      return serverGroups
    }),
  )

  const groups: ChannelGroup[] = perServer.flat()

  return NextResponse.json({ groups })
})
