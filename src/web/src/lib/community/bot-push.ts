import { createLogger } from "@alook/shared"
import type {
  BotAddedFrame,
  BotUpdatedFrame,
  BotRemovedFrame,
  RuntimeConfig,
} from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"

const log = createLogger({ service: "community-bot-push" })

type BotEventFrame = BotAddedFrame | BotUpdatedFrame | BotRemovedFrame

/**
 * Push a bot event (bot:added / bot:updated / bot:removed) to the machine's
 * daemon connection via the WS Durable Object.
 *
 * The event is a HostCommand-shape frame (colon-namespaced), delivered on
 * the same WS pipe the daemon uses for agent:* frames.
 *
 * The WS DO is keyed by credential `do_name` (first 32 hex chars of the
 * credential hash); this helper does the credential lookup at the DO layer.
 * If the daemon is offline, the DO drops the event — the daemon's cold-start
 * warmup will re-fetch authoritative state on next reconnect.
 */
export async function pushBotEventToMachine(
  env: Env,
  machineId: string,
  event: BotEventFrame,
): Promise<void> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/push`
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
      { label: machineId, type: event.type },
    )
    if (!res.ok) {
      log.warn("bot event push non-ok", {
        machineId,
        type: event.type,
        status: res.status,
      })
    }
  } catch (err) {
    log.warn("bot event push threw", {
      machineId,
      type: event.type,
      err: String(err),
    })
  }
}

/**
 * Push an owner-triggered `agent:reset` to the machine's daemon over WS.
 *
 * Narrowly typed (only reset fields, no arbitrary HostCommand) so no caller
 * can smuggle a different command shape onto the wire. Returns the ws-do
 * response's `{ sent }` count — `sent === 0` means the daemon is not
 * currently connected; the caller is expected to translate that into a 409.
 */
export async function pushAgentResetToMachine(
  env: Env,
  machineId: string,
  args: { agentId: string; config: RuntimeConfig; launchId: string },
): Promise<{ sent: number }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-reset`
  const body = JSON.stringify({
    agentId: args.agentId,
    config: args.config,
    launchId: args.launchId,
  })
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { label: machineId, type: "agent:reset" },
    )
    if (!res.ok) {
      log.warn("agent:reset push non-ok", {
        machineId,
        status: res.status,
      })
      return { sent: 0 }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0 }
  } catch (err) {
    log.warn("agent:reset push threw", {
      machineId,
      err: String(err),
    })
    return { sent: 0 }
  }
}
