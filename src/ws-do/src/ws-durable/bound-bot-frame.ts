import type { WsDurableContext } from "./internal"

/**
 * Shared scaffold for every daemon-reported bot frame:
 * resolve the binding, verify machine ownership, then run the write.
 * Binding failures stay under `ws_frame_dropped` with
 * `phase=binding_check`; write failures use the requested category with
 * `phase=write`. Centralizing this prevents new frame types from shipping
 * with a missing phase or the audit-write SLO category on the wrong phase.
 */
export async function handleFrameForBoundBot<B>(
  context: WsDurableContext,
  args: {
    frameType: string
    agentId: string
    machineId: string
    writeCategory?: "ws_frame_dropped" | "ws_frame_dropped_write"
    resolveBinding: () => Promise<B | null | undefined>
    isMatch: (binding: B) => boolean
    write: (binding: B) => Promise<void>
  },
): Promise<void> {
  const { frameType, agentId, machineId, resolveBinding, isMatch, write } = args
  const writeCategory = args.writeCategory ?? "ws_frame_dropped"

  let binding: B | null | undefined
  try {
    binding = await resolveBinding()
  } catch (err) {
    context.log.warn("ws_frame_dropped", {
      category: "ws_frame_dropped",
      frame_type: frameType,
      phase: "binding_check",
      agentId,
      machineId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return
  }
  if (!binding || !isMatch(binding)) {
    context.log.warn(`${frameType} frame for a bot not bound to this machine — dropped`, {
      agentId,
      machineId,
    })
    return
  }
  try {
    await write(binding)
  } catch (err) {
    context.log.warn("ws_frame_dropped", {
      category: writeCategory,
      frame_type: frameType,
      phase: "write",
      agentId,
      machineId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
  }
}
