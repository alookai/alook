import { fork } from "node:child_process";
import type { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  LIFECYCLE_LOCK_FILE,
  LIFECYCLE_RECOVERY_LOCK_FILE,
  SELF_HOSTED_DIR,
} from "./constants.js";
import {
  createAuthorityToken,
  createControlEndpoint,
  requestAuthority,
  supervisorEntryPath,
  type ControlAuthority,
} from "./control-authority.js";

interface LockRecord {
  version: 1;
  token: string;
  createdAt: number;
  heartbeatPath: string;
  authority?: ControlAuthority;
}

export interface LifecycleReservation {
  token: string;
  authority: ControlAuthority;
  heartbeatPath: string;
  sentinel: ManagedChild;
}

type ManagedChild = ReturnType<typeof fork> & EventEmitter;

const STALE_MS = Number(process.env.ALOOK_APP_LIFECYCLE_STALE_MS ?? 10_000);

interface LockSnapshot {
  raw: string;
  record?: LockRecord;
}

interface RecoveryRecord {
  version: 1;
  token: string;
  createdAt: number;
}

interface RecoveryLease {
  token: string;
}

function readLockSnapshot(): LockSnapshot | undefined {
  try {
    const raw = readFileSync(LIFECYCLE_LOCK_FILE, "utf8");
    const value = JSON.parse(raw) as Partial<LockRecord>;
    const record = value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.createdAt === "number" &&
      typeof value.heartbeatPath === "string"
      ? value as LockRecord
      : undefined;
    return { raw, record };
  } catch {
    try {
      return { raw: readFileSync(LIFECYCLE_LOCK_FILE, "utf8") };
    } catch {
      return undefined;
    }
  }
}

function readLock(): LockRecord | undefined {
  return readLockSnapshot()?.record;
}

function heartbeatFresh(record?: LockRecord): boolean {
  try {
    const value = Number(readFileSync(record?.heartbeatPath ?? "", "utf8"));
    return Number.isFinite(value) && Date.now() - value < STALE_MS;
  } catch {
    try {
      return Date.now() - statSync(LIFECYCLE_LOCK_FILE).mtimeMs < STALE_MS;
    } catch {
      return false;
    }
  }
}

async function authorityLive(record?: LockRecord): Promise<boolean> {
  if (!record?.authority) return false;
  try {
    const value = await requestAuthority(record.authority, "status", 1_000);
    return value.runId === record.token && value.service === "lifecycle";
  } catch {
    return false;
  }
}

function readRecoveryRecord(): RecoveryRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(LIFECYCLE_RECOVERY_LOCK_FILE, "utf8")) as Partial<RecoveryRecord>;
    return value.version === 1 && typeof value.token === "string" && typeof value.createdAt === "number"
      ? value as RecoveryRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function recoveryLeaseFresh(): boolean {
  const record = readRecoveryRecord();
  if (record && Date.now() - record.createdAt < STALE_MS) return true;
  try {
    return Date.now() - statSync(LIFECYCLE_RECOVERY_LOCK_FILE).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

function tryAcquireRecoveryLease(): RecoveryLease | undefined {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = createAuthorityToken();
    const record: RecoveryRecord = { version: 1, token, createdAt: Date.now() };
    try {
      const fd = openSync(LIFECYCLE_RECOVERY_LOCK_FILE, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
      return { token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (recoveryLeaseFresh()) return undefined;

      // Move an expired/crashed lease out of the well-known path. Only the
      // contender that subsequently recreates that path wins recovery; other
      // contenders either observe its fresh lease or lose their own rename.
      let expectedRaw: string;
      try {
        expectedRaw = readFileSync(LIFECYCLE_RECOVERY_LOCK_FILE, "utf8");
      } catch {
        continue;
      }
      const quarantine = `${LIFECYCLE_RECOVERY_LOCK_FILE}.expired.${token}`;
      try {
        renameSync(LIFECYCLE_RECOVERY_LOCK_FILE, quarantine);
        const movedRaw = readFileSync(quarantine, "utf8");
        if (movedRaw !== expectedRaw) {
          // A fresh contender replaced the stale lease between observation
          // and rename. Restore it when possible; otherwise that contender
          // will observe its missing token and abort before touching state.
          if (!existsSync(LIFECYCLE_RECOVERY_LOCK_FILE)) renameSync(quarantine, LIFECYCLE_RECOVERY_LOCK_FILE);
          continue;
        }
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      } finally {
        if (existsSync(quarantine)) unlinkSync(quarantine);
      }
    }
  }
  return undefined;
}

function releaseRecoveryLease(lease: RecoveryLease): void {
  if (readRecoveryRecord()?.token === lease.token && existsSync(LIFECYCLE_RECOVERY_LOCK_FILE)) {
    unlinkSync(LIFECYCLE_RECOVERY_LOCK_FILE);
  }
}

function launchSentinel(record: LockRecord): Promise<{ child: ManagedChild; authority: ControlAuthority }> {
  return new Promise((resolve, reject) => {
    const child = fork(supervisorEntryPath(), [], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: process.env,
    }) as ManagedChild;
    let diagnostic = "";
    child.stderr?.on("data", (chunk) => {
      diagnostic = `${diagnostic}${chunk.toString()}`.slice(-4_096);
    });
    const finish = (error?: Error, authority?: ControlAuthority) => {
      clearTimeout(timer);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      child.stderr?.removeAllListeners("data");
      child.stderr?.destroy();
      if (error) {
        child.kill();
        reject(error);
      }
      else resolve({ child, authority: authority! });
    };
    const timer = setTimeout(
      () => finish(new Error(`lifecycle reservation sentinel did not start${diagnostic ? `: ${diagnostic.trim()}` : ""}`)),
      5_000,
    );
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(new Error(`lifecycle reservation sentinel exited (${String(code ?? signal)})`)));
    child.on("message", (message) => {
      const payload = message as { type?: string; status?: { supervisorPid?: number } };
      if (payload.type !== "acquired" || typeof payload.status?.supervisorPid !== "number") return;
      finish(undefined, {
        pid: payload.status.supervisorPid,
        endpoint: record.authority!.endpoint,
        token: record.token,
      });
    });
    child.send({
      mode: "reservation",
      runId: record.token,
      service: "lifecycle",
      token: record.token,
      endpoint: record.authority!.endpoint,
      heartbeatPath: record.heartbeatPath,
    });
  });
}

async function reclaimStaleLock(expected?: LockSnapshot): Promise<boolean> {
  const recoveryLease = tryAcquireRecoveryLease();
  if (!recoveryLease) return false;
  try {
    if (readRecoveryRecord()?.token !== recoveryLease.token) return false;
    const current = readLockSnapshot();
    if (!current || !expected || current.raw !== expected.raw) return false;
    if (await authorityLive(current.record)) return false;
    if (heartbeatFresh(current.record)) return false;
    if (readRecoveryRecord()?.token !== recoveryLease.token) return false;
    unlinkSync(LIFECYCLE_LOCK_FILE);
    if (current.record && existsSync(current.record.heartbeatPath)) unlinkSync(current.record.heartbeatPath);
    return true;
  } finally {
    releaseRecoveryLease(recoveryLease);
  }
}

export async function acquireLifecycleReservation(): Promise<LifecycleReservation> {
  mkdirSync(SELF_HOSTED_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = createAuthorityToken();
    const heartbeatPath = join(SELF_HOSTED_DIR, `.lifecycle-heartbeat.${randomUUID()}`);
    const record: LockRecord = {
      version: 1,
      token,
      createdAt: Date.now(),
      heartbeatPath,
      authority: { pid: 0, endpoint: createControlEndpoint(token, "lifecycle", token), token },
    };
    try {
      const fd = openSync(LIFECYCLE_LOCK_FILE, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
      const { child, authority } = await launchSentinel(record);
      record.authority = authority;
      const temporary = join(SELF_HOSTED_DIR, `.lifecycle.${token}.${process.pid}.tmp`);
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, LIFECYCLE_LOCK_FILE);
      return { token, authority, heartbeatPath, sentinel: child };
    } catch (error) {
      const current = readLock();
      if (current?.token === token && existsSync(LIFECYCLE_LOCK_FILE)) unlinkSync(LIFECYCLE_LOCK_FILE);
      if (current?.token === token && existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockSnapshot();
      if (await authorityLive(existing?.record) || heartbeatFresh(existing?.record)) {
        throw new Error("another Alook lifecycle command owns the startup reservation");
      }
      if (!(await reclaimStaleLock(existing))) {
        throw new Error("could not safely recover the stale Alook lifecycle reservation");
      }
    }
  }
  throw new Error("could not acquire the Alook lifecycle reservation");
}

export async function releaseLifecycleReservation(reservation: LifecycleReservation): Promise<void> {
  const current = readLock();
  if (current?.token === reservation.token) {
    try {
      await requestAuthority(reservation.authority, "release", 2_000);
    } catch {}
    if (existsSync(LIFECYCLE_LOCK_FILE) && readLock()?.token === reservation.token) unlinkSync(LIFECYCLE_LOCK_FILE);
    if (existsSync(reservation.heartbeatPath)) unlinkSync(reservation.heartbeatPath);
  }
  reservation.sentinel.disconnect();
  reservation.sentinel.unref();
}
