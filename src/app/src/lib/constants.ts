import { homedir } from "os";
import { join } from "path";
import type { DevPortProfile } from "@alook/shared";

function resolveBaseDir(): string {
  if (process.env.ALOOK_PROJECT_ROOT) {
    return join(process.env.ALOOK_PROJECT_ROOT, ".alook", "self-hosted");
  }
  return join(homedir(), ".alook", "self-hosted");
}

export const SELF_HOSTED_DIR = resolveBaseDir();
export const PID_FILE = join(SELF_HOSTED_DIR, ".pids.json");

// Same shape as @alook/shared's DEV_PORTS (monorepo `pnpm dev`), but a
// distinct value range — self-hosted instances run alongside a developer's
// own checkout, so they can't share ports with it.
export const DEFAULT_PORTS: DevPortProfile = {
  web: 15210,
  emailWorker: 15211,
  wsDo: 15212,
};

export const WEB_URL = (port: number) => `http://localhost:${port}`;
