import { runNpmUpdate } from "../lib/update.js";
import { log } from "../lib/logger.js";

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

export async function handleCliUpdate(
  version: string,
  onSuccess: () => void,
): Promise<void> {
  if (updating) return;
  if (retryCount >= MAX_RETRIES) return;

  updating = true;
  try {
    log.info(`Updating CLI to v${version}...`);
    const result = await runNpmUpdate(version);
    if (result.success) {
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
