import { readFileSync, existsSync } from "fs"
import { MANIFEST_PATH } from "./paths"
import { restoreState } from "./services"

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) return
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    servicePids?: number[]
    restoreState?: boolean
  }
  // Stop the dev servers first so they release the D1/DO state dir before we
  // swap the developer's backed-up data back in.
  for (const pid of manifest.servicePids ?? []) {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  if (manifest.restoreState) {
    // Give miniflare a moment to release file handles on the state dir.
    await new Promise((r) => setTimeout(r, 1500))
    restoreState()
  }
}
