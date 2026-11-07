import { homedir } from "os";
import { join } from "path";
export { DEFAULT_SELF_HOSTED_PORTS as DEFAULT_PORTS } from "./service-topology.js";

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

export const WEB_URL = (port: number) => `http://localhost:${port}`;
export const WS_URL = (port: number) => `ws://localhost:${port}`;
