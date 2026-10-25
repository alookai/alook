import { createDb, PiiResultFrameSchema, queries, WS_EVENTS } from "@alook/shared"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
import { notifyUserDO } from "./presence-typing"

export async function handlePiiResultFrame(context: WsDurableContext, parsed: unknown, identity: CommunityMachineIdentity): Promise<boolean> {
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "pii_result") return false
  const input = PiiResultFrameSchema.safeParse(parsed)
  if (!input.success) return true
  try {
    const db = createDb(context.env.DB)
    const bot = await queries.communityBot.getBotOwnedBy(db, input.data.botId, identity.userId)
    if (bot?.machineId !== identity.machineId) return true
    const epoch = await queries.communityMachineSession.transitionMachineSessionEpoch(db, { type: "renew", epoch: identity })
    if (epoch.type === "stale_epoch") return true
    await notifyUserDO(context, identity.userId, { ...input.data, type: WS_EVENTS.BOT_PII, machineId: identity.machineId })
  } catch { context.log.warn("PII result unavailable", { machineId: identity.machineId }) }
  return true
}
