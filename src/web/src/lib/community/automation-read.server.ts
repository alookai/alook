import { queries, formatHandle, formatCanonicalRef } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { writeJSON } from "@/lib/middleware/helpers"
import type { NextRequest } from "next/server"
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
