import { NextResponse, NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  isChannelType,
  channelCreation,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  slugify,
  type ChannelType,
  type StoredChannelType,
} from "@alook/shared"
import { fanOutToServerMembers, fanOutToChannel } from "@/lib/community/fanout"
import { createWithCollisionPolicy } from "@/lib/community/create-collision"
import { logAudit } from "@/lib/community/audit"
import { requireServerMember } from "@/lib/community/permissions"
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

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value!

  let body: { name?: string; type?: string; categoryId?: string; topic?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const trimmed = body.name.trim()
  if (!trimmed || trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }
  const name = slugify(trimmed)
  if (!name) {
    return writeError("name is required", 400)
  }
  if (body.type !== undefined && !isChannelType(body.type)) {
    return writeError("type must be 'text' or 'forum'", 400)
  }
  if (body.topic !== undefined) {
    if (typeof body.topic !== "string") return writeError("topic must be a string", 400)
    if (body.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return writeError(`topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters`, 400)
    }
  }

  // Who may create depends on the target location:
  //   - uncategorized OR public category → admin/owner only
  //   - private category → any server member (they own the channel + its roster)
  const isAdmin = canManageServer(member.role)
  let isPrivateCategory = false
  if (body.categoryId) {
    const category = await queries.communityCategory.getCategory(db, body.categoryId)
    if (!category || category.serverId !== serverId) {
      return writeError("category not found", 404)
    }
    isPrivateCategory = !!category.private
  }
  if (!isPrivateCategory && !isAdmin) {
    return writeError("admin permission required", 403)
  }

  // Collision handling via the shared trait-keyed policy (B4 convergence): a
  // top-level channel's creation trait is reject-on-collision — a duplicate name
  // (idx_channel_server_name) is REFUSED with 409, never bumped or merged. Same
  // createWithCollisionPolicy dispatch that runs forum_post's pure-create
  // (bump-retry) and thread's get-or-create (fetch-winner); only the attempt
  // callback + the reject message are top-level-specific. Behavior is unchanged
  // — still 409 "already exists", still the admin/private gate above; only the
  // dispatch mechanism is shared now.
  // Effective stored type — validated to text/forum above; undefined defaults to
  // "text" (same default createChannel applies). Both top-level types are
  // reject-on-collision, so channelCreation resolves the same policy either way.
  const effectiveType: StoredChannelType = body.type === "forum" ? "forum" : "text"
  const createResult = await createWithCollisionPolicy(channelCreation(effectiveType), {
    attempt: () => queries.communityChannel.createChannel(db, {
      serverId,
      categoryId: body.categoryId || null,
      name,
      type: body.type,
      topic: body.topic,
      creatorId: ctx.userId,
    }),
    onReject: () => ({ status: 409, error: "a channel with this name already exists" }),
  })
  if (!createResult.ok) return writeError(createResult.error, createResult.status)
  const row = createResult.value

  // Private-category channels track an explicit roster; seed the creator so
  // audience resolution + the manage-members list are single queries.
  if (isPrivateCategory) {
    await queries.communityChannel.createChannelMember(db, {
      channelId: row.id,
      userId: ctx.userId,
      addedBy: ctx.userId,
    })
  }

  const channel = {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    categoryId: row.categoryId,
    topic: row.topic ?? undefined,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  }

  // A private channel's creation must NOT fan out to the whole server (that
  // would leak its existence). Route it through the channel audience (creator
  // + admins); public/uncategorized channels stay server-wide.
  if (isPrivateCategory) {
    await fanOutToChannel(row.id, {
      type: WS_EVENTS.CHANNEL_CREATE,
      serverId,
      channel,
    })
  } else {
    await fanOutToServerMembers(serverId, {
      type: WS_EVENTS.CHANNEL_CREATE,
      serverId,
      channel,
    })
  }

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "channel_create",
    targetType: "channel",
    targetId: channel.id,
  })

  return writeJSON({ channel }, 201)
})
