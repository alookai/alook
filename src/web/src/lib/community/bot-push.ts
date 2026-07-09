import { createLogger } from "@alook/shared"
import type {
  BotAddedFrame,
  BotUpdatedFrame,
  BotRemovedFrame,
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
