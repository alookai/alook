import { mkdirSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import { chromium } from "@playwright/test"
import { AUTH_DIR, MANIFEST_PATH, SERVICE_STATE_PATH } from "./paths"
import { loginAndSaveState } from "./auth"
import {
  prepareServices,
  resetDb,
  startServices,
  backupState,
  REUSE_EXISTING,
  stopServicesAndRestore,
} from "./services"
import { createLifecycleState, writeLifecycleState } from "./service-lifecycle"
import { USER_KEYS, type RunManifest, type SeededUser, type UserKey } from "./users"

export default async function globalSetup(): Promise<void> {
  rmSync(AUTH_DIR, { recursive: true, force: true })
  mkdirSync(AUTH_DIR, { recursive: true })
  writeLifecycleState(SERVICE_STATE_PATH, createLifecycleState())

  try {
    prepareServices()

    // Local runs: back up the developer's D1/DO state, wipe to a clean DB, and
    // restore it on teardown (see global-teardown). CI has no prior state.
    let backedUp = false
    if (!REUSE_EXISTING) {
      backedUp = backupState()
      writeLifecycleState(SERVICE_STATE_PATH, createLifecycleState(backedUp))
      resetDb()
    }
    await startServices()

    // Unique-per-run stamp so re-runs against a non-reset DB don't collide.
    const stamp = `${process.pid.toString(36)}${Math.floor(process.hrtime()[1] / 1e3).toString(36)}`

    const users = {} as Record<UserKey, SeededUser>
    const browser = await chromium.launch()
    try {
      for (const key of USER_KEYS) {
        const statePath = resolve(AUTH_DIR, `${key}.json`)
        users[key] = await loginAndSaveState(browser, key, stamp, statePath)
      }
    } finally {
      await browser.close()
    }

    const manifest: RunManifest = { stamp, users }
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  } catch (error) {
    await stopServicesAndRestore()
    throw error
  }
}
