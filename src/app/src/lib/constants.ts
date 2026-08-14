import { homedir } from "os";
import { join } from "path";
import type { DevPortProfile } from "@alook/shared";

function resolveBaseDir(): string {
  if (process.env.ALOOK_SELF_HOSTED_DIR) {
    return process.env.ALOOK_SELF_HOSTED_DIR;
  }
  if (process.env.ALOOK_PROJECT_ROOT) {
    return join(process.env.ALOOK_PROJECT_ROOT, ".alook", "self-hosted");
  }
  return join(homedir(), ".alook", "self-hosted");
}

export const SELF_HOSTED_DIR = resolveBaseDir();
export const PID_FILE = join(SELF_HOSTED_DIR, ".pids.json");
export const DAEMON_BASE_DIR = join(SELF_HOSTED_DIR, "daemon");

// Same shape as @alook/shared's DEV_PORTS (monorepo `pnpm dev`), but a
// distinct value range — self-hosted instances run alongside a developer's
// own checkout, so they can't share ports with it.
export const DEFAULT_PORTS: DevPortProfile = {
  web: 15210,
  emailWorker: 15211,
  wsDo: 15212,
  wakeWorker: 15213,
};

export const WEB_URL = (port: number) => `http://localhost:${port}`;
export const WS_URL = (port: number) => `ws://localhost:${port}`;
