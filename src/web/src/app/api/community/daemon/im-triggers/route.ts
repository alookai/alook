import { NextResponse } from "next/server"
import { queries, type DaemonImTriggerConfig } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth-policy"
import { machineAuthPolicy } from "@/lib/middleware/community-daemon-auth"

export const GET = withAuth(machineAuthPolicy, async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const bots = await queries.communityBot.listBotsForMachine(db, ctx.machineId, {
    includeInactive: false,
  })
  const botIds = bots.map((b) => b.id)
  const rows = await queries.communityBotWebhook.listDaemonPollImTriggersForBots(
    db,
    ctx.userId,
    botIds,
  )

  const triggers: DaemonImTriggerConfig[] = rows
    .filter((row) => row.provider === "wechat")
    .map((row) => ({
      triggerId: row.id,
      botId: row.botUserId,
      provider: "wechat",
      name: row.name,
      enabled: row.enabled,
      accessPolicy: row.config.accessPolicy,
      allowedSenders: row.config.allowedSenders,
      instruction: row.instruction,
    }))

  return NextResponse.json({ triggers })
})
