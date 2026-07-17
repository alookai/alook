import { mkdirSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import { AUTH_DIR, MANIFEST_PATH } from "./paths"
import { loginAndSaveState } from "./auth"
import { resetDb, startServices, backupState, REUSE_EXISTING } from "./services"
import { USER_KEYS, type RunManifest, type SeededUser, type UserKey } from "./users"

export default async function globalSetup(): Promise<void> {
  rmSync(AUTH_DIR, { recursive: true, force: true })
  mkdirSync(AUTH_DIR, { recursive: true })

  // Local runs: back up the developer's D1/DO state, wipe to a clean DB, and
  // restore it on teardown (see global-teardown). CI has no prior state.
  let backedUp = false
  if (!REUSE_EXISTING) {
    backedUp = backupState()
    resetDb()
  }
  const services = await startServices()

  // Unique-per-run stamp so re-runs against a non-reset DB don't collide.
  const stamp = `${process.pid.toString(36)}${Math.floor(process.hrtime()[1] / 1e3).toString(36)}`

  const users = {} as Record<UserKey, SeededUser>
  for (const key of USER_KEYS) {
    const statePath = resolve(AUTH_DIR, `${key}.json`)
    users[key] = await loginAndSaveState(key, stamp, statePath)
  }

  const manifest: RunManifest & { servicePids: number[]; restoreState: boolean } = {
    stamp,
    users,
    servicePids: services.map((s) => s.proc.pid).filter((p): p is number => !!p),
    restoreState: backedUp,
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}
