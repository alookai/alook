import { readDaemonVersion } from "../version.js";
import { daemonResume } from "./daemonStart.js";
import { acquireDaemonReplacementLock, ownsDaemon, readDaemonLaunchRecord, removeReplacementLockIfMatches, stopExactDaemonPid } from "./daemonState.js";
import type { DaemonOwnerContext as RefreshContext } from "./daemonOwnership.js";

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
