import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readDaemonVersion } from "../version.js";
import { readShellEnvironment } from "./shellEnvironment.js";
import {
  acquireDaemonReplacementLock, daemonProcessArguments, daemonResume, pidfilePathById,
  readDaemonLaunchRecord, readPidFile, removeReplacementLockIfMatches, stopExactDaemonPid,
} from "./daemonStart.js";
import { sameDaemonOwnership, type DaemonOwnerContext } from "./daemonOwnership.js";

type RefreshContext = DaemonOwnerContext;

function ownsDaemon(context: RefreshContext): boolean {
  const current = readPidFile(pidfilePathById(context.baseDir, context.machineId));
  return sameDaemonOwnership(current, context);
}

export function createDaemonRefreshHandler(context: RefreshContext, options: {
  readEnvironment?: typeof readShellEnvironment;
  spawnProcess?: typeof spawn;
} = {}): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) return;
    if (!ownsDaemon(context)) throw new Error("ownership_changed");
    active = true;
    try {
      const environment = await (options.readEnvironment ?? readShellEnvironment)();
      if (!ownsDaemon(context)) throw new Error("ownership_changed");
      const priorEnvironment = { ...process.env };
      if (process.env.ALOOK_DAEMON_PACKAGE_WRAPPER) environment.ALOOK_DAEMON_PACKAGE_WRAPPER = process.env.ALOOK_DAEMON_PACKAGE_WRAPPER;
      if (process.env.NODE_ENV === "test") {
        for (const [key, value] of Object.entries(process.env)) {
          if (key === "NODE_ENV" || key.startsWith("ALOOK_DAEMON_TEST_")) environment[key] = value;
        }
      }
      const helper = (options.spawnProcess ?? spawn)(process.execPath, daemonProcessArguments("refresh-run"), {
        env: environment, cwd: process.cwd(), detached: true, windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      await new Promise<void>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("exit", (code) => code === 0 ? resolve() : reject(new Error("restart_failed")));
        helper.send!({ context, requestId: randomUUID(), priorEnvironment }, (error) => { if (error) reject(error); });
        helper.unref();
        helper.channel?.unref();
      });
    } finally { active = false; }
  };
}

export async function replaceDaemonForRefresh(input: {
  context: RefreshContext;
  requestId: string;
  priorEnvironment: NodeJS.ProcessEnv;
}): Promise<void> {
  const { context, requestId } = input;
  const launch = readDaemonLaunchRecord(context.baseDir, context.machineId);
  if (launch.daemonVersion !== readDaemonVersion() || !ownsDaemon(context)) throw new Error("ownership_changed");
  const lock = acquireDaemonReplacementLock({ baseDir: context.baseDir, machineId: context.machineId, requestId });
  try {
    if (!ownsDaemon(context)) throw new Error("ownership_changed");
    await stopExactDaemonPid(context.pid);
    try {
      await daemonResume({ id: context.machineId, baseDir: context.baseDir, requestId });
    } catch {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, input.priorEnvironment);
      await daemonResume({ id: context.machineId, baseDir: context.baseDir, requestId });
    }
  } finally { removeReplacementLockIfMatches(lock.path, lock.lock); }
}

export async function daemonRefreshFromIpc(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("refresh helper requires parent IPC");
  try {
    const input = await new Promise<Parameters<typeof replaceDaemonForRefresh>[0]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.removeListener("message", receive);
        reject(new Error("refresh helper input unavailable"));
      }, 5000);
      function receive(message: unknown): void {
        clearTimeout(timeout);
        if (!message || typeof message !== "object") { reject(new Error("invalid refresh input")); return; }
        const value = message as Parameters<typeof replaceDaemonForRefresh>[0];
        if (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.requestId) || !value.context
          || !Number.isSafeInteger(value.context.pid) || value.context.pid <= 0
          || typeof value.context.machineId !== "string" || typeof value.context.baseDir !== "string"
          || typeof value.context.startedAt !== "string" || typeof value.context.ownerToken !== "string"
          || !value.priorEnvironment || typeof value.priorEnvironment !== "object") {
          reject(new Error("invalid refresh input")); return;
        }
        resolve(value);
      }
      process.once("message", receive);
    });
    await replaceDaemonForRefresh(input);
  } finally { if (process.connected) process.disconnect(); }
}
