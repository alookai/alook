import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_DIR } from "./constants.js";

export interface ControlAuthority {
  pid: number;
  endpoint: string;
  token: string;
}

export interface AuthorityStatus {
  ok: boolean;
  runId: string;
  service: string;
  supervisorPid: number;
  childPid?: number;
  childState: "starting" | "running" | "exited" | "stopped" | "error";
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  error?: string;
}

function positiveDuration(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  const duration = Math.floor(value);
  return Number.isFinite(value) && duration > 0 ? duration : fallback;
}

export const TERMINATION_GRACE_MS = positiveDuration("ALOOK_APP_TERMINATION_GRACE_MS", 5_000);
export const WINDOWS_TREE_COMMAND_TIMEOUT_MS = positiveDuration("ALOOK_APP_WINDOWS_TREE_COMMAND_TIMEOUT_MS", 5_000);
export const SUPERVISOR_ACQUISITION_BUDGET_MS = positiveDuration(
  "ALOOK_APP_SUPERVISOR_ACQUISITION_BUDGET_MS",
  3 * WINDOWS_TREE_COMMAND_TIMEOUT_MS,
);
export const TERMINATION_BUDGET_MS = positiveDuration(
  "ALOOK_APP_TERMINATION_BUDGET_MS",
  (2 * TERMINATION_GRACE_MS) + (7 * WINDOWS_TREE_COMMAND_TIMEOUT_MS) + 2_000,
);
const TERMINATION_REQUEST_TIMEOUT_MS = TERMINATION_BUDGET_MS + 2_000;

export function createAuthorityToken(): string {
  return randomBytes(32).toString("base64url");
}

function ensurePrivateControlDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`private control path is not a directory: ${path}`);
  }
  const getuid = process.getuid;
  if (getuid && stat.uid !== getuid()) {
    throw new Error(`private control directory is owned by another user: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function createControlEndpoint(runId: string, label: string, token: string): string {
  const id = createHash("sha256").update(`${runId}:${label}:${token}`).digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\alook-app-${id}`;
  const preferred = join(CONTROL_DIR, `${id}.sock`);
  const directory = Buffer.byteLength(preferred) <= 100
    ? CONTROL_DIR
    : `/tmp/alook-app-${process.getuid?.() ?? "user"}`;
  ensurePrivateControlDir(directory);
  return join(directory, `${id}.sock`);
}

export function supervisorEntryPath(): string {
  return process.env.ALOOK_APP_SUPERVISOR_ENTRY ?? join(dirname(fileURLToPath(import.meta.url)), "service-supervisor.js");
}

export function requestAuthority(
  authority: ControlAuthority,
  action: "status" | "terminate" | "release",
  timeoutMs = action === "terminate" ? TERMINATION_REQUEST_TIMEOUT_MS : 2_000,
): Promise<AuthorityStatus> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(authority.endpoint);
    let settled = false;
    let buffer = "";
    const finish = (error?: Error, value?: AuthorityStatus) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`authority ${action} timed out`)));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: authority.token, action })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as AuthorityStatus;
        if (!value.ok) finish(new Error(value.error ?? "authority rejected request"));
        else finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
