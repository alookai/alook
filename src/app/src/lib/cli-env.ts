import { DEFAULT_PORTS, WEB_URL, SELF_HOSTED_DIR } from "./constants.js";
import { readPids } from "./pid.js";

/**
 * Build env vars for spawning @alook/cli subprocesses.
 *
 * Three scenarios — all resolve ALOOK_PROJECT_ROOT via SELF_HOSTED_DIR:
 *   1. Production install:   ~/.alook/self-hosted
 *   2. Dev mode (monorepo):  <ALOOK_PROJECT_ROOT>/.alook/self-hosted
 *   3. App mode (npx):       ~/.alook/self-hosted  (same as 1)
 */
export function buildCliEnv(webPort?: number): Record<string, string> {
  const port = webPort ?? (readPids().ports?.web ?? DEFAULT_PORTS.web);
  return {
    ...(process.env as Record<string, string>),
    ALOOK_SERVER_URL: WEB_URL(port),
    ALOOK_PROJECT_ROOT: SELF_HOSTED_DIR,
    ALOOK_CMD_PREFIX: "npx @alook/app cli",
    ALOOK_HEALTH_PORT: "19515",
  };
}
