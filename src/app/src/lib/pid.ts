import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { PID_FILE, SERVICE_NAMES, type ServiceName, type ServicePortProfile } from "./constants.js";
import type { AuthorityStatus, ControlAuthority } from "./control-authority.js";

type RegistryPhase = "starting" | "ready" | "recovery-required";

export interface ServiceRegistryEntry {
  name: ServiceName;
  authority: ControlAuthority;
  childPid: number;
  childState: AuthorityStatus["childState"];
  businessPort: number;
  inspectorPort: number;
  healthUrl: string;
  logPath: string;
}

export interface ServiceRegistry {
  version: 1;
  runId: string;
  phase: RegistryPhase;
  profile: ServicePortProfile;
  services: Partial<Record<ServiceName, ServiceRegistryEntry>>;
  createdAt: string;
}

function isAuthority(value: unknown): value is ControlAuthority {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.pid === "number" && typeof candidate.endpoint === "string" && typeof candidate.token === "string";
}

function isServiceRegistry(value: unknown): value is ServiceRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ServiceRegistry>;
  if (candidate.version !== 1 || typeof candidate.runId !== "string" || !candidate.profile || !candidate.services) return false;
  if (!candidate.phase || !["starting", "ready", "recovery-required"].includes(candidate.phase)) return false;
  for (const name of SERVICE_NAMES) {
    const ports = candidate.profile[name];
    if (!ports || !Number.isInteger(ports.business) || !Number.isInteger(ports.inspector)) return false;
    const entry = candidate.services[name];
    if (!entry) continue;
    if (entry.name !== name || !isAuthority(entry.authority) || typeof entry.childPid !== "number") return false;
    if (entry.businessPort !== ports.business || entry.inspectorPort !== ports.inspector) return false;
    if (typeof entry.healthUrl !== "string" || typeof entry.logPath !== "string") return false;
  }
  return true;
}

export function readRegistry(): ServiceRegistry | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(PID_FILE, "utf8"));
    return isServiceRegistry(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readRegistryText(): string | undefined {
  try {
    return readFileSync(PID_FILE, "utf8");
  } catch {
    return undefined;
  }
}

export function writeRegistry(registry: ServiceRegistry): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  const raw = readRegistryText();
  if (raw) {
    const current = readRegistry();
    if (!current) throw new Error("refusing to replace a malformed or unverifiable service registry");
    if (current.runId !== registry.runId) {
      throw new Error(`refusing to replace service generation ${current.runId} with ${registry.runId}`);
    }
  }
  const temporary = join(dirname(PID_FILE), `.pids.${registry.runId}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, PID_FILE);
}

export function clearRegistry(runId: string): boolean {
  const current = readRegistry();
  if (!current || current.runId !== runId) return false;
  unlinkSync(PID_FILE);
  return true;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
