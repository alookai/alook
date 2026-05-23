import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { runNpmUpdate } from "../lib/update.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ module: "updater" });
import { lastUpdateMarkerPath } from "./config.js";

let updating = false;
let retryCount = 0;
const MAX_RETRIES = 3;

export function isUpdating(): boolean {
  return updating;
}

export function resetUpdateState(): void {
  updating = false;
  retryCount = 0;
}

export function readUpdateMarker(profile?: string): string | null {
  try {
    return readFileSync(lastUpdateMarkerPath(profile), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function writeUpdateMarker(version: string, profile?: string): void {
  try {
    writeFileSync(lastUpdateMarkerPath(profile), version, { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export function clearUpdateMarker(profile?: string): void {
  try {
    unlinkSync(lastUpdateMarkerPath(profile));
  } catch {
    // already gone
  }
}

export async function handleCliUpdate(
  version: string,
  onSuccess: () => void,
  profile?: string,
): Promise<void> {
  if (updating) return;
  if (retryCount >= MAX_RETRIES) return;

  if (process.env.ALOOK_CMD_PREFIX) {
    log.info(`Skipping auto-update in app mode — user should run: npx @alook/app@latest update`);
    return;
  }

  const marker = readUpdateMarker(profile);
  if (marker === version) {
    log.info(`Skipping update to v${version} — already attempted (marker exists)`);
    return;
  }

  updating = true;
  try {
    log.info(`Updating CLI to v${version}...`);
    const result = await runNpmUpdate(version);
    if (result.success) {
      writeUpdateMarker(version, profile);
      log.info(`CLI updated to v${version} — restarting`);
      onSuccess();
    } else {
      retryCount++;
      log.error(`CLI update failed (attempt ${retryCount}/${MAX_RETRIES}): ${result.output}`);
    }
  } catch (e) {
    retryCount++;
    log.error(`CLI update error (attempt ${retryCount}/${MAX_RETRIES})`, e);
  } finally {
    updating = false;
  }
}
