import { readDaemonOwnership, sameDaemonOwnership, type DaemonOwnership, type DaemonOwnerContext } from "./daemonOwnership.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseReleaseVersion } from "@alook/shared";
import type { Logger } from "../logger.js";
import { daemonDirById, pidfilePathById, readPidFile } from "./daemonState.js";
import { ensurePrivateDir, writePrivateJsonAtomic } from "./privateJsonFile.js";

const UPDATE_INTENT_SCHEMA_VERSION = 1;

const UPDATE_LOG_MAX_BYTES = 512 * 1024;

const UPDATE_LOG_KEEP_BYTES = 256 * 1024;

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface DaemonUpdateIntent extends DaemonOwnership {
  schemaVersion: 1;
  requestId: string;
}

export type DaemonSelfUpdateContext = DaemonOwnerContext;

export interface SelfUpdateDeps {
  spawnProcess?: typeof spawn;
  npmExecPath?: string;
  npmLaunchEnv?: NodeJS.ProcessEnv;
  npmLaunchPlatform?: NodeJS.Platform;
  npmLaunchNodePath?: string;
  npmLaunchFileProbe?: NpmLaunchFileProbe;
  logger?: Pick<Logger, "info" | "warn">;
}

export interface NpmLaunchCommand {
  file: string;
  prefixArgs: string[];
}

export interface NpmLaunchFileProbe {
  isFile(filePath: string): boolean;
  isExecutable(filePath: string): boolean;
}

function intentPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update-intent.json");
}

export function updateLogPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update.log");
}

export function updatePackageMapPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update-package-map.json");
}

function scrub(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/\b(?:cmk|cmt)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_024);
}

export function appendUpdateLog(baseDir: string, machineId: string, event: string, fields: Record<string, unknown> = {}): void {
  const filePath = updateLogPath(baseDir, machineId);
  ensurePrivateDir(path.dirname(filePath));
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > UPDATE_LOG_MAX_BYTES) {
      const data = fs.readFileSync(filePath);
      fs.writeFileSync(filePath, data.subarray(Math.max(0, data.length - UPDATE_LOG_KEEP_BYTES)), { mode: 0o600 });
    }
    const safeFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scrub(value)]));
    fs.appendFileSync(filePath, `${JSON.stringify({ time: new Date().toISOString(), event, ...safeFields })}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Update logging is diagnostic only and cannot own process correctness.
  }
}

export function readIntent(baseDir: string, machineId: string): DaemonUpdateIntent {
  const filePath = intentPath(baseDir, machineId);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon update intent type");
  fs.chmodSync(filePath, 0o600);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DaemonUpdateIntent>;
  if (
    value.schemaVersion !== UPDATE_INTENT_SCHEMA_VERSION
    || typeof value.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || !Number.isInteger(value.pid)
    || (value.pid ?? 0) <= 0
    || typeof value.machineId !== "string"
    || typeof value.startedAt !== "string"
    || typeof value.ownerToken !== "string"
  ) throw new Error("invalid daemon update intent");
  return value as DaemonUpdateIntent;
}

export function removeIntentIfMatches(baseDir: string, machineId: string, requestId: string): void {
  try {
    const current = readIntent(baseDir, machineId);
    if (current.requestId === requestId) fs.unlinkSync(intentPath(baseDir, machineId));
  } catch {  }
}

const defaultNpmLaunchFileProbe: NpmLaunchFileProbe = {
  isFile(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  isExecutable(filePath) {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

function pathEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === "path");
  return entry?.[1];
}

function launchFromNpmPath(args: {
  npmPath: string;
  platform: NodeJS.Platform;
  nodePath: string;
  probe: NpmLaunchFileProbe;
  requireExecutable: boolean;
}): NpmLaunchCommand | null {
  const pathApi = args.platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(args.npmPath) || !args.probe.isFile(args.npmPath)) return null;
  const extension = pathApi.extname(args.npmPath).toLowerCase();
  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return { file: args.nodePath, prefixArgs: [args.npmPath] };
  }
  if (args.platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    const cliPath = pathApi.join(pathApi.dirname(args.npmPath), "node_modules", "npm", "bin", "npm-cli.js");
    return args.probe.isFile(cliPath)
      ? { file: args.nodePath, prefixArgs: [cliPath] }
      : null;
  }
  if (args.requireExecutable && !args.probe.isExecutable(args.npmPath)) return null;
  return { file: args.npmPath, prefixArgs: [] };
}

export function resolveNpmLaunchCommand(options: {
  npmExecPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodePath?: string;
  probe?: NpmLaunchFileProbe;
} = {}): NpmLaunchCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const probe = options.probe ?? defaultNpmLaunchFileProbe;
  const inherited = options.npmExecPath ?? env.npm_execpath;
  if (inherited) {
    const launch = launchFromNpmPath({
      npmPath: inherited,
      platform,
      nodePath,
      probe,
      requireExecutable: platform !== "win32",
    });
    if (launch) return launch;
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["npm.exe", "npm.cmd", "npm.bat", "npm"] : ["npm"];
  const pathValue = pathEnvironment(env, platform);
  for (const directory of pathValue?.split(pathApi.delimiter) ?? []) {
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    for (const name of names) {
      const launch = launchFromNpmPath({
        npmPath: pathApi.join(directory, name),
        platform,
        nodePath,
        probe,
        requireExecutable: platform !== "win32",
      });
      if (launch) return launch;
    }
  }
  throw new Error("npm launch context unavailable and no safe npm executable was found on PATH; daemon remains online");
}

function readTestPackageMap(baseDir: string, machineId: string): Record<string, string> | null {
  if (process.env.NODE_ENV !== "test") return null;
  const filePath = updatePackageMapPath(baseDir, machineId);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon update package map type");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("daemon update package map must be mode 0600");
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid daemon update package map");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "latest" && !parseReleaseVersion(key)) throw new Error("invalid daemon update package map key");
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("invalid daemon update package map value");
    result[key] = value;
  }
  return result;
}

export function packageSpec(baseDir: string, machineId: string, version: "latest" | string): string {
  const mapped = readTestPackageMap(baseDir, machineId)?.[version];
  if (mapped) return mapped;
  return `@alook/daemon@${version}`;
}

export function fixedNpmArgs(args: {
  packageSpec: string;
  command: "replace" | "resume";
  machineId: string;
  baseDir: string;
  requestId: string;
}): string[] {
  return [
    "exec",
    "--yes",
    "--no-audit",
    `--package=${args.packageSpec}`,
    "--",
    "alook-daemon",
    "daemon",
    args.command,
    "--id",
    args.machineId,
    "--base-dir",
    args.baseDir,
    "--request-id",
    args.requestId,
  ];
}

export function openUpdateLog(baseDir: string, machineId: string): number {
  appendUpdateLog(baseDir, machineId, "helper_spawn_requested");
  const filePath = updateLogPath(baseDir, machineId);
  const fd = fs.openSync(filePath, "a", 0o600);
  fs.chmodSync(filePath, 0o600);
  return fd;
}

export function createDaemonSelfUpdateHandler(
  context: DaemonSelfUpdateContext,
  deps: SelfUpdateDeps = {},
): () => void {
  let updateInFlight: ChildProcess | null = null;
  return () => {
    if (updateInFlight && updateInFlight.exitCode === null && updateInFlight.signalCode === null) return;
    let requestId = "";
    try {
      const current = readDaemonOwnership(readPidFile(pidfilePathById(context.baseDir, context.machineId)));
      if (!current || !sameDaemonOwnership(current, context)) throw new Error("daemon ownership changed before update launch");
      const npmLaunch = resolveNpmLaunchCommand({
        npmExecPath: deps.npmExecPath,
        env: deps.npmLaunchEnv,
        platform: deps.npmLaunchPlatform,
        nodePath: deps.npmLaunchNodePath,
        probe: deps.npmLaunchFileProbe,
      });
      requestId = crypto.randomUUID();
      const intent: DaemonUpdateIntent = {
        schemaVersion: UPDATE_INTENT_SCHEMA_VERSION,
        requestId,
        ...current,
      };
      writePrivateJsonAtomic(intentPath(context.baseDir, context.machineId), intent);
      const logFd = openUpdateLog(context.baseDir, context.machineId);
      try {
        const child = (deps.spawnProcess ?? spawn)(npmLaunch.file, [
          ...npmLaunch.prefixArgs,
          ...fixedNpmArgs({
            packageSpec: packageSpec(context.baseDir, context.machineId, "latest"),
            command: "replace",
            machineId: context.machineId,
            baseDir: context.baseDir,
            requestId,
          }),
        ], {
          detached: true,
          shell: false,
          stdio: ["ignore", logFd, logFd],
        });
        updateInFlight = child;
        const clear = (event: string, fields: Record<string, unknown>): void => {
          appendUpdateLog(context.baseDir, context.machineId, event, fields);
          if (updateInFlight === child) updateInFlight = null;
          removeIntentIfMatches(context.baseDir, context.machineId, requestId);
        };
        child.once("exit", (code, signal) => clear("helper_exited", { code, signal }));
        child.once("error", (error) => clear("helper_process_error", { error }));
        child.unref();
        deps.logger?.info("daemon self-update helper launched", { machineId: context.machineId });
      } finally {
        fs.closeSync(logFd);
      }
    } catch (error) {
      if (requestId) removeIntentIfMatches(context.baseDir, context.machineId, requestId);
      appendUpdateLog(context.baseDir, context.machineId, "helper_spawn_failed", { error });
      deps.logger?.warn("daemon self-update helper launch failed", { machineId: context.machineId, error: scrub(error) });
    }
  };
}
