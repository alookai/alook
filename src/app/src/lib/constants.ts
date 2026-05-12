import { homedir } from "os";
import { join } from "path";

export const SELF_HOSTED_DIR = join(homedir(), ".alook", "self-hosted");
export const PID_FILE = join(SELF_HOSTED_DIR, ".pids.json");
export const DEV_VARS_FILE = join(SELF_HOSTED_DIR, "web", ".dev.vars");

export const DEFAULT_PORTS = {
  web: 3000,
  emailWorker: 8787,
  wsDo: 8789,
} as const;

export const WEB_URL = (port: number) => `http://localhost:${port}`;
