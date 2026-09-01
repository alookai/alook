import {
  AgentInterruptRequestSchema,
  createDb,
  queries,
  withD1Retry,
} from "@alook/shared"
import type { UserConnectionState, WsDurableContext } from "./internal"

export async function handleUserAgentInterrupt(
  context: WsDurableContext,
  state: UserConnectionState,
  parsed: unknown,
): Promise<boolean> {
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "agent:interrupt") return false
  const request = AgentInterruptRequestSchema.safeParse(parsed)
  if (!request.success) return true

  try {
    const db = createDb(context.env.DB)
    const binding = await withD1Retry(
      () => queries.communityBot.getBotBindingWithOwner(db, request.data.agentId),
      { route: "ws-do:agent-interrupt-binding" },
    )
    if (!binding || binding.ownerUserId !== state.userId) return true
    const doNames = await withD1Retry(
      () => queries.communityMachine.getActiveDoNamesForMachine(db, binding.machineId),
      { route: "ws-do:agent-interrupt-machine" },
    )
    const body = JSON.stringify(request.data)
    for (const doName of doNames) {
      try {
        const stub = context.env.WS_DO.get(context.env.WS_DO.idFromName("community-machine:" + doName))
        await stub.fetch(new Request("http://internal/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }))
      } catch (err) {
        context.log.warn("agent interrupt push failed", { agentId: request.data.agentId, doName, err: String(err) })
      }
    }
    if (doNames.length === 0) context.log.warn("agent interrupt route unavailable", { agentId: request.data.agentId })
  } catch (err) {
    context.log.warn("agent interrupt routing failed", { agentId: request.data.agentId, err: String(err) })
  }
  return true
}
