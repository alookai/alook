import { NextResponse, type NextRequest } from "next/server"
import {
  queries,
  CommunityAgentChannelMemberRequestSchema,
  DM_SERVER,
  formatHandle,
  isForumPost,
  isThread,
  parseRef,
} from "@alook/shared"
import type {
  CommunityCliChannelMemberResult as ChannelMemberResult,
  CommunityCliServerMember as ServerMember,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/channelMember — `alook channel member --channel <ref>`.
 * Returns the followed members of a channel/thread.
 *
 * Branches by resolved target:
 *   - DM ref → 400 (channel-scoped). Rejected UP FRONT (before
 *     `resolveTargetForMember`) so an un-opened DM surfaces the correct
 *     channel-scoped 400 instead of a misleading 404 "dm not found".
 *   - thread / forum post (`type = "thread" | "forum_post"`) → always private on
 *     the wire; returns the participant roster (`community_thread_participant`).
 *     Both are the NOTIFY dimension: a thread/post carries its own notify set
 *     irrespective of its parent channel/forum's public/private state, so a
 *     public post lists only its participants, never the whole server.
 *   - public top-level channel/forum → `{ visibility: "public", hint }` (no
 *     roster enumeration — every server member can see it, so the agent should
 *     use `alook server member --server <name>` instead).
 *   - private channel / private forum → `{ visibility: "private", members }`
 *     sourced from `resolveScopeMembers` (the same audience the fan-out and
 *     human UI use).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentChannelMemberRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }

  // Reject DM refs up front: an un-opened DM would otherwise trip
  // `resolveTargetForMember`'s 404 "dm not found" before the DM-branch guard
  // below could emit the specific channel-scoped 400.
  try {
    const p = parseRef(parsed.data.channel)
    if (p.server === DM_SERVER) {
      return NextResponse.json(
        { error: "channel member is channel-scoped — DM refs are not supported" },
        { status: 400 },
      )
    }
  } catch {
    // Fall through — resolveTargetForMember returns the canonical 400.
  }

  const resolved = await resolveTargetForMember(db, ctx.botUserId, parsed.data.channel, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)
  if (resolved.kind === "dm") {
    return NextResponse.json(
      { error: "channel member is channel-scoped — DM refs are not supported" },
      { status: 400 },
    )
  }

  const channelId = resolved.channelId
  const access = await requireChannelAccess(db, channelId, ctx.botUserId)
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status })

  const { channel, isPrivate } = access.value

  // Thread / forum-post branch: both are the NOTIFY dimension — the roster is
  // the participant set (`community_thread_participant`), always private on the
  // wire, regardless of the parent channel/forum's public/private state. A
  // public forum post therefore lists only its participants, not the server.
  if (isThread(channel.type) || isForumPost(channel.type)) {
    const userIds = await queries.communityThread.listThreadParticipantUserIds(db, channelId)
    const members = await hydrateMembers(db, channel.serverId, userIds)
    return NextResponse.json<ChannelMemberResult>({ visibility: "private", members })
  }

  if (!isPrivate) {
    const server = await queries.communityServer.getServer(db, channel.serverId)
    const serverName = server?.name ?? channel.serverId
    const hint = `This channel is public. Use \`alook server member --server ${serverName}\` to list who can see it.`
    return NextResponse.json<ChannelMemberResult>({ visibility: "public", hint })
  }

  const scoped = await queries.communityMembersResolver.resolveScopeMembers(db, { scope: "channel", scopeId: channelId })
  const userIds = scoped.map((s) => s.userId)
  const members = await hydrateMembers(db, channel.serverId, userIds)
  return NextResponse.json<ChannelMemberResult>({ visibility: "private", members })
})

/**
 * Hydrate a user id list into `ServerMember[]` — mirrors `listMembers`'s
 * mapping (formatHandle, default role "member", nickname iff set). Users
 * whose account is soft-deleted drop out via `getMembersByUserIds`'s inner
 * join on `user`. Users missing a `community_server_member` row (shouldn't
 * happen in normal flow) also drop out; they never surface as a stub row.
 */
async function hydrateMembers(
  db: ReturnType<typeof getDb>,
  serverId: string,
  userIds: string[],
): Promise<ServerMember[]> {
  if (userIds.length === 0) return []
  const rows = await queries.communityMember.getMembersByUserIds(db, serverId, userIds)
  return rows.map((r) => ({
    handle: formatHandle(r.userName ?? "", r.discriminator ?? "0000"),
    role: r.role ?? "member",
    ...(r.nickname ? { nickname: r.nickname } : {}),
  }))
}
