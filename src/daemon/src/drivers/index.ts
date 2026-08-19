/**
 * Driver registry — the single place that maps a runtime id to its driver.
 *
 * `getDriver(runtimeId)` is how the daemon obtains a backend. The runtime is
 * an explicit choice made at agent-create time — there is no auto-migration
 * or alias between runtimes.
 */
import type { Driver } from "../types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { CursorDriver } from "./cursor.js";
import { OpenCodeDriver } from "./opencode.js";
import { PiDriver } from "./pi.js";

export type RuntimeId =
  | "claude"
  | "codex"
  | "cursor"
  | "opencode"
  | "pi";

const driverFactories: Record<RuntimeId, () => Driver> = {
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  cursor: () => new CursorDriver(),
  opencode: () => new OpenCodeDriver(),
  pi: () => new PiDriver(),
};

export function getDriver(runtimeId: string): Driver {
  const createDriver = (driverFactories as Record<string, (() => Driver) | undefined>)[runtimeId];
  const driver = createDriver?.();
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(", ")}`);
  }
  return driver;
}

export function listRuntimeIds(): RuntimeId[] {
  return Object.keys(driverFactories) as RuntimeId[];
}

export {
  ClaudeDriver,
  CodexDriver,
  CursorDriver,
  OpenCodeDriver,
  PiDriver,
};
