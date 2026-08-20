import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { chromium } from "@playwright/test"
import { AUTH_DIR, MANIFEST_PATH } from "./paths"
import { loginAndSaveState } from "./auth"
import {
  cleanupFailedSetup,
  prepareServiceLifecycle,
  prepareServices,
  readPriorServiceManifest,
  startServices,
  type RestorePolicy,
  type ServiceLifecycleDecision,
} from "./services"
import { USER_KEYS, type SeededUser, type UserKey } from "./users"

type LifecycleManifest = {
  stamp: string
  users: Partial<Record<UserKey, SeededUser>>
  servicePids: number[]
  restoreState: boolean
  restorePolicy: RestorePolicy
}

function writeManifest(manifest: LifecycleManifest): void {
  const stagingPath = `${MANIFEST_PATH}.pending-${process.pid}`
  writeFileSync(stagingPath, JSON.stringify(manifest, null, 2))
  renameSync(stagingPath, MANIFEST_PATH)
}

function ownedPids(services: Array<{ proc: { pid?: number } }>): number[] {
  const pids = services.map((service) => service.proc.pid)
  if (pids.some((pid) => !pid)) {
    throw new Error("Started E2E service did not expose an owned PID")
  }
  return pids as number[]
}

export default async function globalSetup(): Promise<void> {
  const priorManifest = readPriorServiceManifest()
  prepareServices()

  let decision: ServiceLifecycleDecision | null = null
  let ownedServicePids: number[] = []
  try {
    decision = await prepareServiceLifecycle(priorManifest)

    rmSync(AUTH_DIR, { recursive: true, force: true })
    mkdirSync(AUTH_DIR, { recursive: true })

    // Unique-per-run stamp so re-runs against a non-reset DB don't collide.
    const stamp = `${process.pid.toString(36)}${Math.floor(process.hrtime()[1] / 1e3).toString(36)}`
    const lifecycleManifest = (): LifecycleManifest => ({
      stamp,
      users: {},
      servicePids: ownedServicePids,
      restoreState: decision!.restoreState,
      restorePolicy: decision!.restorePolicy,
    })

    const services = await startServices(decision, (ownedServices) => {
      ownedServicePids = ownedPids(ownedServices)
      // Publish ownership immediately after every detached spawn so a hard
      // interruption remains recoverable by the next run.
      writeManifest(lifecycleManifest())
    })
    ownedServicePids = ownedPids(services)
    writeManifest(lifecycleManifest())

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

    writeManifest({
      stamp,
      users,
      servicePids: ownedServicePids,
      restoreState: decision.restoreState,
      restorePolicy: decision.restorePolicy,
    })
  } catch (error) {
    if (decision) {
      try {
        await cleanupFailedSetup(decision, ownedServicePids)
        if (decision.restoreState) rmSync(AUTH_DIR, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "E2E global setup failed and lifecycle cleanup also failed",
        )
      }
    }
    throw error
  }
}
