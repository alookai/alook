import { createLogger } from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"

const log = createLogger({ service: "community-machine-disconnect" })

/**
 * Ask the WS DO worker to force-close the live daemon connection for a
 * community machine. Sends `{ type:"error", code:"AUTH_REJECTED" }` then
 * closes the socket. Best-effort: if no daemon is currently connected, the
 * call is a no-op. Post-refactor the DO is keyed by machineId (cm_...),
 * not the pairing token.
 */
export async function forceCloseCommunityMachine(env: Env, machineId: string): Promise<void> {
  const path = `/community-machine/${encodeURIComponent(machineId)}/force-close`
  try {
    const res = await wsDoFetch(env, path, { method: "POST" }, { label: machineId })
    if (!res.ok) {
      log.warn("force-close non-ok", { status: res.status, machineId })
    }
  } catch (err) {
    log.warn("force-close fetch failed", { err: String(err), machineId })
  }
}
