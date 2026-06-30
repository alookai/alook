/**
 * Driver registry — the single place that maps a runtime id to its driver.
 *
 * `getDriver(runtimeId)` is how the daemon obtains a backend. There is NO alias
 * and NO auto-migration between runtimes (notably `kimi` vs `kimi-sdk`): the
 * runtime is an explicit choice made at agent-create time.
 */
import type { Driver } from "../types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GeminiDriver } from "./gemini.js";
import { CopilotDriver } from "./copilot.js";
import { CursorDriver } from "./cursor.js";
import { OpenCodeDriver } from "./opencode.js";
import { AntigravityDriver } from "./antigravity.js";
import { KimiDriver } from "./kimi.js";
import { KimiSdkDriver } from "./kimiSdk.js";
import { PiDriver } from "./pi.js";

export type RuntimeId =
  | "claude"
  | "codex"
  | "antigravity"
  | "copilot"
  | "cursor"
  | "gemini"
  | "kimi"
  | "kimi-sdk"
  | "opencode"
  | "pi";

const driverFactories: Record<RuntimeId, () => Driver> = {
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  antigravity: () => new AntigravityDriver(),
  copilot: () => new CopilotDriver(),
  cursor: () => new CursorDriver(),
  gemini: () => new GeminiDriver(),
  // Two separate Kimi runtimes:
  //   - `kimi`     = legacy child-process driver (backward-compat; deprecated).
  //   - `kimi-sdk` = canonical in-process SDK driver (frontend "Kimi Code").
  // No alias / no auto-migration; explicit pick at agent-create time.
  kimi: () => new KimiDriver(),
  "kimi-sdk": () => new KimiSdkDriver(),
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
  GeminiDriver,
  CopilotDriver,
  CursorDriver,
  OpenCodeDriver,
  AntigravityDriver,
  KimiDriver,
  KimiSdkDriver,
  PiDriver,
};
