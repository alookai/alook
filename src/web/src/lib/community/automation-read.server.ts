import { queries, formatHandle } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { writeJSON } from "@/lib/middleware/helpers"
import type { NextRequest } from "next/server"

type ReadContext = { env: Env; userId: string; beforeCreate: () => Promise<Response | null> }

export async function readAutomationMachines(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const machines = await queries.automation.listMachines(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ machines: machines.map(({ id, name }) => ({ id, name })) })
}

export async function readAutomationFriends(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const friends = await queries.automation.listFriends(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ friends: friends.map((friend) => ({ name: friend.name, handle: formatHandle(friend.name, friend.discriminator) })) })
}

export async function readAutomationServers(_req: NextRequest, ctx: ReadContext) {
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const servers = await queries.automation.listServers(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ servers: servers.map((server) => ({ name: server.name, handle: formatHandle(server.name, server.discriminator) })) })
}
