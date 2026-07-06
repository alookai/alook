import { createLogger } from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"

const log = createLogger({ service: "community-machine-disconnect" })

/**
 * Ask the WS DO worker to force-close the live daemon connection for a
 * given credential DO-name suffix (first 32 hex chars of the credential
 * hash). Callers look the suffix up from `community_machine_credential.do_name`
 * because the DO is keyed by that suffix — not by `machineId` — so a machine
 * with N historical credentials fans out N force-close calls.
 */
export async function forceCloseCommunityMachineByDoName(env: Env, doName: string): Promise<void> {
  const path = `/community-machine/${encodeURIComponent(doName)}/force-close`
  try {
    const res = await wsDoFetch(env, path, { method: "POST" }, { label: doName })
    if (!res.ok) {
      log.warn("force-close non-ok", { status: res.status, doName })
    }
  } catch (err) {
    log.warn("force-close fetch failed", { err: String(err), doName })
  }
}

/** Force-close every DO for a set of credential do_name suffixes. */
export async function forceCloseCommunityMachinesByDoNames(
  env: Env,
  doNames: string[]
): Promise<void> {
  await Promise.all(doNames.map((n) => forceCloseCommunityMachineByDoName(env, n)))
}
