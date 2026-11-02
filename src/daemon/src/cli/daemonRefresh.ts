import { spawn, type ChildProcess } from "node:child_process";
import { MachineRefreshRequestIdSchema, MachineRefreshResultSchema, type MachineRefreshResult } from "@alook/shared";
import { readDaemonVersion } from "../version.js";
import { readShellEnvironment } from "./shellEnvironment.js";
import {
  acquireDaemonReplacementLock, daemonProcessArguments, daemonResume, pidfilePathById,
  readDaemonLaunchRecord, readPidFile, removeReplacementLockIfMatches, stopExactDaemonPid,
} from "./daemonStart.js";
import type { DaemonSelfUpdateContext } from "./daemonUpdate.js";

type RefreshContext = DaemonSelfUpdateContext;
type RefreshErrorCode = Extract<MachineRefreshResult, { status: "error" }>["code"];
const failure = (requestId: string, code: RefreshErrorCode): MachineRefreshResult => ({ requestId, status: "error", code });

function ownsDaemon(context: RefreshContext): boolean {
  const current = readPidFile(pidfilePathById(context.baseDir, context.machineId));
  return current?.pid === context.pid && current.machineId === context.machineId
    && current.startedAt === context.startedAt && current.ownerToken === context.ownerToken;
}

export function createDaemonRefreshHandler(context: RefreshContext, options: {
  readEnvironment?: typeof readShellEnvironment;
  spawnProcess?: typeof spawn;
  completedRequestId?: () => string | undefined;
  startupRequestId?: string;
  startupPending?: () => boolean;
} = {}): (requestId: string) => Promise<MachineRefreshResult | undefined> {
  let active: string | undefined;
  let child: ChildProcess | undefined;
  return async (requestId) => {
    MachineRefreshRequestIdSchema.parse(requestId);
    if (options.startupPending?.()) return requestId === options.startupRequestId ? undefined : failure(requestId, "refresh_in_progress");
    if (requestId === options.completedRequestId?.()) return { requestId, status: "complete" };
    if (active) return active === requestId ? undefined : failure(requestId, "refresh_in_progress");
    if (!ownsDaemon(context)) return failure(requestId, "ownership_changed");
    active = requestId;
    let environment: NodeJS.ProcessEnv;
    try { environment = await (options.readEnvironment ?? readShellEnvironment)(); }
    catch { active = undefined; return failure(requestId, "environment_unavailable"); }
    if (!ownsDaemon(context)) { active = undefined; return failure(requestId, "ownership_changed"); }
    const priorEnvironment = { ...process.env };
    if (process.env.ALOOK_DAEMON_PACKAGE_WRAPPER) environment.ALOOK_DAEMON_PACKAGE_WRAPPER = process.env.ALOOK_DAEMON_PACKAGE_WRAPPER;
    if (process.env.NODE_ENV === "test") {
      for (const [key, value] of Object.entries(process.env)) {
        if (key === "NODE_ENV" || key.startsWith("ALOOK_DAEMON_TEST_")) environment[key] = value;
      }
    }
    try {
      child = (options.spawnProcess ?? spawn)(process.execPath, daemonProcessArguments("refresh-run"), {
        env: environment, cwd: process.cwd(), detached: true, windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const helper = child;
      return await new Promise((resolve) => {
        const finish = (result: MachineRefreshResult | undefined): void => {
          if (child === helper) { child = undefined; active = undefined; }
          resolve(result);
        };
        helper.once("error", () => finish(failure(requestId, "restart_failed")));
        helper.once("exit", () => finish(failure(requestId, "restart_failed")));
        helper.on("message", (message: unknown) => {
          const parsed = MachineRefreshResultSchema.safeParse(message);
          if (parsed.success && parsed.data.requestId === requestId) finish(parsed.data);
        });
        helper.send?.({ context, requestId, priorEnvironment }, (error) => {
          if (error) finish(failure(requestId, "restart_failed"));
        });
        helper.unref();
        helper.channel?.unref();
      });
    } catch { child = undefined; active = undefined; return failure(requestId, "restart_failed"); }
  };
}

export async function replaceDaemonForRefresh(input: {
  context: RefreshContext;
  requestId: string;
  priorEnvironment: NodeJS.ProcessEnv;
}): Promise<void> {
  const { context, requestId } = input;
  MachineRefreshRequestIdSchema.parse(requestId);
  const launch = readDaemonLaunchRecord(context.baseDir, context.machineId);
  if (launch.daemonVersion !== readDaemonVersion() || !ownsDaemon(context)) throw new Error("ownership_changed");
  const lock = acquireDaemonReplacementLock({ baseDir: context.baseDir, machineId: context.machineId, requestId });
  try {
    if (!ownsDaemon(context)) throw new Error("ownership_changed");
    await stopExactDaemonPid(context.pid);
    try {
      await daemonResume({ id: context.machineId, baseDir: context.baseDir, requestId,
        refreshResult: { requestId, status: "complete" } });
    } catch {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, input.priorEnvironment);
      await daemonResume({ id: context.machineId, baseDir: context.baseDir, requestId,
        refreshResult: failure(requestId, "restart_failed") });
    }
  } finally { removeReplacementLockIfMatches(lock.path, lock.lock); }
}

export async function daemonRefreshFromIpc(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("refresh helper requires parent IPC");
  const input = await new Promise<Parameters<typeof replaceDaemonForRefresh>[0]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("refresh helper input unavailable")), 5000);
    process.once("message", (message: unknown) => {
      clearTimeout(timeout);
      if (!message || typeof message !== "object") { reject(new Error("invalid refresh input")); return; }
      const value = message as Parameters<typeof replaceDaemonForRefresh>[0];
      if (!MachineRefreshRequestIdSchema.safeParse(value.requestId).success || !value.context
        || !Number.isSafeInteger(value.context.pid) || value.context.pid <= 0
        || typeof value.context.machineId !== "string" || typeof value.context.baseDir !== "string"
        || typeof value.context.startedAt !== "string" || typeof value.context.ownerToken !== "string"
        || !value.priorEnvironment || typeof value.priorEnvironment !== "object") {
        reject(new Error("invalid refresh input")); return;
      }
      resolve(value);
    });
  });
  try { await replaceDaemonForRefresh(input); }
  catch (error) {
    const code = error instanceof Error && error.message === "ownership_changed" ? "ownership_changed" : "restart_failed";
    if (process.connected) await new Promise<void>((resolve) => process.send?.(failure(input.requestId, code), () => resolve()));
  } finally { if (process.connected) process.disconnect(); }
}
