import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { createHash } from "crypto"
import { getPlatformProxy } from "wrangler"
import type { CaseResources } from "./case-fixture"
import { createDb } from "../../../../../shared/src/db/index"
import { fillHistoricalProfile, type HistoricalActor, type HistoricalRow } from "./historical-profile"
import { REPO_ROOT, SERVICE_STATE_PATH, WEB_URL } from "../_setup/paths"
import { readLifecycleState } from "../_setup/service-lifecycle"

export async function seedLocalHistory(input: {
  channelId: string
  actors: readonly HistoricalActor[]
  rows: readonly HistoricalRow[]
  idPrefix: string
  resources: CaseResources
  register: (id: string) => void
  lifecycle: string
  configSHA256: string
}) {
  const state = readLifecycleState(SERVICE_STATE_PATH)
  const web = new URL(WEB_URL)
  const persistence = resolve(REPO_ROOT, "src/web/.wrangler/state/v3")
  const configPath = resolve(REPO_ROOT, "src/web/wrangler.toml")
  if (!["localhost", "127.0.0.1"].includes(web.hostname) || state?.status !== "healthy"
    || !state.services.some(service => service.name === "web-zones" && service.healthUrl === `${web.origin}/api/health`)
    || readFileSync(SERVICE_STATE_PATH, "utf8") !== input.lifecycle || !existsSync(resolve(persistence, "d1"))
    || createHash("sha256").update(readFileSync(configPath)).digest("hex") !== input.configSHA256) throw new Error("History requires the current managed local database lifecycle")
  for (const service of state.services) {
    if (!service.pid) throw new Error("History managed service has no process owner")
    process.kill(service.pid, 0)
  }
  let cancelled = false
  let proxyPending: ReturnType<typeof getPlatformProxy<Pick<CloudflareEnv, "DB">>> | undefined
  let work: ReturnType<typeof fillHistoricalProfile> | undefined
  const owned = input.resources.own(null, async () => {
    cancelled = true
    await work?.catch(() => undefined)
    const proxy = await proxyPending?.catch(() => undefined)
    await proxy?.dispose()
  })
  const assertActive = () => {
    if (cancelled || Date.now() >= input.resources.deadline) throw new Error("History preparation exceeded its case lifetime")
  }
  let bodyError: unknown
  let failed = false
  try {
    assertActive()
    proxyPending = getPlatformProxy<Pick<CloudflareEnv, "DB">>({
      configPath, persist: { path: persistence }, remoteBindings: false, envFiles: [],
    })
    const proxy = await proxyPending
    assertActive()
    work = fillHistoricalProfile(createDb(proxy.env.DB), { ...input, assertActive })
    return await work
  } catch (error) {
    bodyError = error
    failed = true
    throw error
  } finally {
    try { await owned.close() } catch (error) {
      if (failed) throw new AggregateError([bodyError, error], "History preparation and proxy cleanup failed")
      throw error
    }
  }
}
