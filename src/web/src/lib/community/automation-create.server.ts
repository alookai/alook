import type { NextRequest } from "next/server"
import { formatHandle } from "@alook/shared"
import { writeJSON } from "@/lib/middleware/helpers"
import { createBotForUser, type ResourceCreationContext } from "./create-bot.server"
import { createServerForUser } from "./create-server.server"

export async function createAutomationBot(req: NextRequest, ctx: ResourceCreationContext) {
  const response = await createBotForUser(req, ctx)
  if (!response.ok) return response
  const { bot } = await response.json() as { bot: { name: string; discriminator: string } }
  return writeJSON({ bot: { handle: formatHandle(bot.name, bot.discriminator) } }, response.status)
}

export async function createAutomationServer(req: NextRequest, ctx: ResourceCreationContext) {
  const response = await createServerForUser(req, ctx)
  if (!response.ok) return response
  const { server } = await response.json() as { server: { id: string; name: string; discriminator: string } }
  return writeJSON({ server: {
    handle: formatHandle(server.name, server.discriminator),
    url: `${new URL(req.url).origin}/c/channels/${encodeURIComponent(server.id)}`,
  } }, response.status)
}
