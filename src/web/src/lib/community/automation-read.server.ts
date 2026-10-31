import { queries, formatHandle, formatCanonicalRef, parseNameAndTag, DEFAULT_MEMBERS_PAGE_SIZE } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import type { NextRequest } from "next/server"
import { parseMemberCursor } from "./messages"
import { projectMachineBackends } from "./machine-options.server"

type ReadContext = { env: Env; userId: string; beforeCreate: () => Promise<Response | null> }

export async function readAutomationMachines(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const machines = await queries.automation.listMachines(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ machines: machines.map(({ id, name, status, availableRuntimes }) => ({ id, name, status, backends: projectMachineBackends(queries.communityBot.normalizeMachineRuntimes(availableRuntimes), { includeCatalogMetadata: false }) })) })
}

export async function readAutomationFriends(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const friends = await queries.automation.listFriends(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ friends: friends.map((friend) => ({ name: friend.name, handle: formatHandle(friend.name, friend.discriminator), is_my_bot: friend.isBot && friend.ownerUserId === ctx.userId })) })
}

export async function readAutomationServers(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const servers = await queries.communityChannel.listChannelRefDirectoryForUser(getPrimaryDb(ctx.env.DB), ctx.userId, { railOrder: false })
  return writeJSON({ servers: servers.map((server) => {
    const handle = formatHandle(server.name, server.discriminator)
    return { name: server.name, handle, channels: server.channels.map((channel) => ({
      name: channel.name, type: channel.type,
      ref: formatCanonicalRef({ type: channel.type, serverHandle: handle, name: channel.name }),
    })) }
  }) })
}

export async function readAutomationMembers(req: NextRequest, ctx: ReadContext & { params?: Record<string, string> }) {
  const serverRef = ctx.params?.id ?? ""
  if (!parseNameAndTag(serverRef)) return writeError("Use a full server handle", 400)
  const cursorParam = new URL(req.url).searchParams.get("cursor")
  const cursor = parseMemberCursor(cursorParam)
  if (cursorParam && !cursor) return writeError("Invalid member cursor", 400)
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const db = getPrimaryDb(ctx.env.DB)
  const [server] = await queries.communityServer.resolveServerByNameForMember(db, ctx.userId, serverRef)
  if (!server) return writeError("Server not found", 404)
  const page = await queries.communityMember.listMembersPaginated(db, server.id, { cursor, limit: DEFAULT_MEMBERS_PAGE_SIZE })
  return writeJSON({
    server: formatHandle(server.name, server.discriminator),
    url: `${new URL(req.url).origin}/c/channels/${encodeURIComponent(server.id)}`,
    members: page.members.map((member) => ({ handle: formatHandle(member.userName ?? "", member.discriminator ?? "0000"), role: member.role ?? "member" })),
    hasMore: page.hasMore,
    cursor: page.cursor ? `${page.cursor.joinedAt}|${page.cursor.id}` : undefined,
  })
}
