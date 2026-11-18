import { mkdirSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import { chromium } from "@playwright/test"
import { AUTH_DIR, MANIFEST_PATH, SERVICE_STATE_PATH } from "./paths"
import { loginAndSaveState } from "./auth"
import {
  prepareServices,
  startServices,
  stopServicesAndRestore,
  publicStaticQaManifest,
} from "./services"
import { createLifecycleState, writeLifecycleState } from "./service-lifecycle"
import { USER_KEYS, type RunManifest, type SeededUser, type UserKey } from "./users"
import { measureSetupAsync, measureSetupSync, prepareSetupUsers } from "./setup-work"

export default async function globalSetup(): Promise<void> {
  publicStaticQaManifest()
  rmSync(AUTH_DIR, { recursive: true, force: true })
  mkdirSync(AUTH_DIR, { recursive: true })
  writeLifecycleState(SERVICE_STATE_PATH, createLifecycleState())

  try {
    measureSetupSync("prepare-services", prepareServices)

    await measureSetupAsync("start-services", startServices)

    // Unique-per-run stamp so re-runs against a non-reset DB don't collide.
    const stamp = `${process.pid.toString(36)}${Math.floor(process.hrtime()[1] / 1e3).toString(36)}`

    const users = {} as Record<UserKey, SeededUser>
    const browser = await measureSetupAsync("launch-browser", () => chromium.launch())
    try {
      await prepareSetupUsers(USER_KEYS, async (key, index) => {
        const statePath = resolve(AUTH_DIR, `${key}.json`)
        users[key] = await measureSetupAsync("prepare-user", () => loginAndSaveState(browser, key, stamp, statePath), index + 1)
      })
    } finally {
      await measureSetupAsync("close-browser", () => browser.close())
    }

    const manifest: RunManifest = { stamp, users }
    measureSetupSync("write-manifest", () => writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2)))
  } catch (error) {
    await measureSetupAsync("setup-cleanup", stopServicesAndRestore)
    throw error
  }
}
