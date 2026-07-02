import { DEV_WS_DO_URL, createLogger } from "@alook/shared"

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
    const res = await env.WS_DO_WORKER.fetch(`http://internal${path}`, { method: "POST" })
    if (!res.ok) {
      log.warn("force-close non-ok", { status: res.status, machineId })
    }
    return
  } catch {
    // service binding unavailable — fall through
  }
  const wsDoUrl = (env as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined
  const fallback = wsDoUrl || DEV_WS_DO_URL
  try {
    await fetch(`${fallback}${path}`, { method: "POST" })
  } catch (err) {
    log.warn("force-close fetch failed", { err: String(err), machineId })
  }
}
