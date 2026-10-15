import { createDb, HostRuntimeModelsFrameSchema, queries, WS_EVENTS, type RuntimeModelDiscoveryResult } from "@alook/shared"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
import { notifyUserDO } from "./presence-typing"

export async function handleRuntimeModelsFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "runtime_models") return false
  const input = HostRuntimeModelsFrameSchema.safeParse(parsed)
  if (!input.success) return true
  const frame = input.data
  const runtime = frame.result.status === "complete"
    ? frame.result.runtimeReport.find((item) => item.id === frame.runtimeId)
    : undefined
  if (frame.result.status === "complete" && !runtime) return true
  let result: RuntimeModelDiscoveryResult = frame.result.status === "error"
    ? frame.result
    : { status: "complete", catalog: runtime?.reasoning ?? null }
  try {
    const db = createDb(context.env.DB)
    const transition = await queries.communityMachineSession.transitionMachineSessionEpoch(db,
      frame.result.status === "complete"
        ? { type: "ready", epoch: identity, metadata: { availableRuntimes: frame.result.runtimeReport } }
        : { type: "renew", epoch: identity },
    )
    if (transition.type === "stale_epoch") return true
  } catch {
    context.log.warn("runtime model discovery persistence failed", { machineId: identity.machineId, runtimeId: frame.runtimeId })
    result = { status: "error", code: "model_discovery_failed", message: "Could not save the discovered models" }
  }
  await notifyUserDO(context, identity.userId, {
    type: WS_EVENTS.RUNTIME_MODELS,
    machineId: identity.machineId,
    requestId: frame.requestId,
    runtimeId: frame.runtimeId,
    result,
  })
  return true
}
