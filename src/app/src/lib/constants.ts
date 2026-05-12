import { homedir } from "os";
import { join } from "path";

function resolveBaseDir(): string {
  if (process.env.ALOOK_PROJECT_ROOT) {
    return join(process.env.ALOOK_PROJECT_ROOT, ".alook", "self-hosted");
  }
  return join(homedir(), ".alook", "self-hosted");
}

export const SELF_HOSTED_DIR = resolveBaseDir();
export const PID_FILE = join(SELF_HOSTED_DIR, ".pids.json");

export const DEFAULT_PORTS = {
  web: 3000,
  emailWorker: 8787,
  wsDo: 8789,
} as const;

export const WEB_URL = (port: number) => `http://localhost:${port}`;
