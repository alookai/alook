import { IDENTITY_KEY } from "./internal"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
import { handleReadyFrame } from "./machine-ready"
import {
  handleDiagnosticCommandAck,
  handleMachineHeartbeatAck,
} from "./machine-lifecycle"
import {
  handleAgentCommandAck,
  handleAgentSessionFrame,
  handleSessionErrorFrame,
} from "./machine-restart"
import type { MachineRestartHooks } from "./machine-restart"
import {
  handleActivityFrame,
  handleAuditFrame,
  handleTypingFrame,
  handleTypingStopFrame,
} from "./machine-telemetry"

export async function handleCommunityMachineMessage(
  context: WsDurableContext,
  ws: WebSocket,
  parsed: unknown,
  hooks: MachineRestartHooks,
): Promise<void> {
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  if (!identity) {
    context.log.warn("community machine message with no cached identity")
    return
  }

  if (await handleMachineHeartbeatAck(context, ws, parsed, identity)) return
  if (handleDiagnosticCommandAck(context, ws, parsed, identity)) return

  // The router is intentionally first-match. Keep identity before every
  // frame and preserve ack → session error → activity → typing → typing stop
  // → agent session → audit → strict ready. A recognized frame is consumed
  // even when its handler drops it for binding, persistence, or payload state.
  if (await handleAgentCommandAck(
    context,
    parsed,
    identity,
  )) return
  if (await handleSessionErrorFrame(
    context,
    parsed,
    identity,
    hooks,
  )) return
  if (await handleActivityFrame(
    context,
    parsed,
    identity,
  )) return
  if (await handleTypingFrame(
    context,
    parsed,
    identity,
  )) return
  if (await handleTypingStopFrame(
    context,
    parsed,
    identity,
  )) return
  if (await handleAgentSessionFrame(
    context,
    parsed,
    identity,
    hooks,
  )) return
  if (await handleAuditFrame(
    context,
    parsed,
    identity,
  )) return
  await handleReadyFrame(
    context,
    parsed,
    identity,
    ws,
  )
}
