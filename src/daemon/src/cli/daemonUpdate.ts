import { readDaemonOwnership, sameDaemonOwnership } from "./daemonOwnership.js";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { parseReleaseVersion, releaseVersionGte } from "@alook/shared";
import { readDaemonVersion } from "../version.js";
import { daemonResume } from "./daemonStart.js";
import { acquireDaemonReplacementLock, pidfilePathById, readDaemonLaunchRecord, readPidFile, removeReplacementLockIfMatches, stopExactDaemonPid } from "./daemonState.js";
import { REQUEST_ID_PATTERN, type DaemonUpdateIntent, type NpmLaunchCommand, appendUpdateLog, readIntent, removeIntentIfMatches, resolveNpmLaunchCommand, packageSpec, fixedNpmArgs, openUpdateLog } from "./daemonSelfUpdate.js";

function currentPidTuple(baseDir: string, machineId: string): ReturnType<typeof readDaemonOwnership> {
  return readDaemonOwnership(readPidFile(pidfilePathById(baseDir, machineId)));
}

function removeOldPidfileIfMatches(baseDir: string, intent: DaemonUpdateIntent): void {
  const filePath = pidfilePathById(baseDir, intent.machineId);
  if (!sameDaemonOwnership(currentPidTuple(baseDir, intent.machineId), intent)) return;
  try { fs.unlinkSync(filePath); } catch {  }
}

async function runPinnedResume(args: {
  npmLaunch: NpmLaunchCommand;
  version: string;
  machineId: string;
  baseDir: string;
  requestId: string;
}): Promise<void> {
  const fd = openUpdateLog(args.baseDir, args.machineId);
  try {
    const child = spawn(args.npmLaunch.file, [
      ...args.npmLaunch.prefixArgs,
      ...fixedNpmArgs({
        packageSpec: packageSpec(args.baseDir, args.machineId, args.version),
        command: "resume",
        machineId: args.machineId,
        baseDir: args.baseDir,
        requestId: args.requestId,
      }),
    ], {
      shell: false,
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`rollback resume exited ${signal ?? code}`));
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}

export async function daemonReplace(opts: {
  id: string;
  baseDir?: string;
  requestId: string;
}): Promise<void> {
  if (!REQUEST_ID_PATTERN.test(opts.requestId)) throw new Error("invalid replacement request id");
  const baseDir = opts.baseDir ?? process.env.ALOOK_DATA_DIR;
  if (!baseDir) throw new Error("daemon replace requires --base-dir");
  const intent = readIntent(baseDir, opts.id);
  if (intent.machineId !== opts.id || intent.requestId !== opts.requestId) {
    throw new Error("daemon update intent mismatch");
  }
  const launch = readDaemonLaunchRecord(baseDir, opts.id);
  const currentVersion = readDaemonVersion();
  if (!parseReleaseVersion(currentVersion) || !parseReleaseVersion(launch.daemonVersion)) {
    throw new Error("daemon replacement version is invalid");
  }
  if (currentVersion === launch.daemonVersion || !releaseVersionGte(currentVersion, launch.daemonVersion)) {
    appendUpdateLog(baseDir, opts.id, "replacement_not_newer", {
      currentVersion,
      priorVersion: launch.daemonVersion,
    });
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    return;
  }
  if (!sameDaemonOwnership(currentPidTuple(baseDir, opts.id), intent)) {
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    throw new Error("daemon ownership changed before replacement");
  }

  const npmLaunch = resolveNpmLaunchCommand();
  const acquired = acquireDaemonReplacementLock({ baseDir, machineId: opts.id, requestId: opts.requestId });
  let oldStopped = false;
  try {
    if (!sameDaemonOwnership(currentPidTuple(baseDir, opts.id), intent)) {
      throw new Error("daemon ownership changed after replacement lock");
    }
    appendUpdateLog(baseDir, opts.id, "replacement_started", {
      priorVersion: launch.daemonVersion,
      nextVersion: currentVersion,
    });
    await stopExactDaemonPid(intent.pid);
    oldStopped = true;
    removeOldPidfileIfMatches(baseDir, intent);
    try {
      await daemonResume({ id: opts.id, baseDir, requestId: opts.requestId });
      appendUpdateLog(baseDir, opts.id, "replacement_ready", { version: currentVersion });
    } catch (error) {
      appendUpdateLog(baseDir, opts.id, "replacement_start_failed", { error });
      await runPinnedResume({
        npmLaunch,
        version: launch.daemonVersion,
        machineId: opts.id,
        baseDir,
        requestId: opts.requestId,
      });
      appendUpdateLog(baseDir, opts.id, "rollback_ready", { version: launch.daemonVersion });
    }
  } catch (error) {
    appendUpdateLog(baseDir, opts.id, oldStopped ? "replacement_terminal_failure" : "replacement_aborted", { error });
    throw error;
  } finally {
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    removeReplacementLockIfMatches(acquired.path, acquired.lock);
  }
}
