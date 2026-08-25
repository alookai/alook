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
export const LIFECYCLE_LOCK_FILE = join(SELF_HOSTED_DIR, ".lifecycle.lock");
export const LIFECYCLE_RECOVERY_LOCK_FILE = join(SELF_HOSTED_DIR, ".lifecycle.recovery.lock");
export const CONTROL_DIR = join(SELF_HOSTED_DIR, "control");
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

export const SERVICE_NAMES = ["web", "emailWorker", "wsDo", "wakeWorker"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

interface ServicePortPair {
  business: number;
  inspector: number;
}

export type ServicePortProfile = Record<ServiceName, ServicePortPair>;

export function createServicePortProfile(ports: DevPortProfile): ServicePortProfile {
  return {
    web: { business: ports.web, inspector: ports.web + 4019 },
    emailWorker: { business: ports.emailWorker, inspector: ports.web + 4021 },
    wsDo: { business: ports.wsDo, inspector: ports.web + 4020 },
    wakeWorker: { business: ports.wakeWorker, inspector: ports.web + 4022 },
  };
}

export const DEFAULT_SERVICE_PROFILE = createServicePortProfile(DEFAULT_PORTS);

export const WEB_URL = (port: number) => `http://localhost:${port}`;
export const WS_URL = (port: number) => `ws://localhost:${port}`;
