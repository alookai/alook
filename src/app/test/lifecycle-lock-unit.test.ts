import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  closeSync: vi.fn(),
  createAuthorityToken: vi.fn(),
  existsSync: vi.fn(),
  fork: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  randomUUID: vi.fn(() => "uuid"),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  requestAuthority: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ fork: fixture.fork }));
vi.mock("node:crypto", () => ({ randomUUID: fixture.randomUUID }));
vi.mock("node:fs", () => ({
  closeSync: fixture.closeSync,
  existsSync: fixture.existsSync,
  mkdirSync: fixture.mkdirSync,
  openSync: fixture.openSync,
  readFileSync: fixture.readFileSync,
  renameSync: fixture.renameSync,
  statSync: fixture.statSync,
  unlinkSync: fixture.unlinkSync,
  writeFileSync: fixture.writeFileSync,
}));
vi.mock("../src/lib/constants.js", () => ({
  LIFECYCLE_LOCK_FILE: "/lifecycle.lock",
  LIFECYCLE_RECOVERY_LOCK_FILE: "/recovery.lock",
  SELF_HOSTED_DIR: "/self",
}));
vi.mock("../src/lib/control-authority.js", () => ({
  createAuthorityToken: fixture.createAuthorityToken,
  createControlEndpoint: vi.fn(() => "/control.sock"),
  requestAuthority: fixture.requestAuthority,
  supervisorEntryPath: vi.fn(() => "/supervisor.js"),
}));

import { acquireLifecycleReservation, releaseLifecycleReservation } from "../src/lib/lifecycle-lock.js";

function sentinel(pid = 80_001) {
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    stderr: PassThrough;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  value.pid = pid;
  value.stderr = new PassThrough();
  value.send = vi.fn();
  value.kill = vi.fn();
  value.disconnect = vi.fn();
  value.unref = vi.fn();
  return value;
}

function staleRecord(token = "old-token") {
  return {
    version: 1,
    token,
    createdAt: 0,
    heartbeatPath: "/heartbeat",
    authority: { pid: 1, endpoint: "/old-control.sock", token },
  };
}

function eexist() {
  return Object.assign(new Error("exists"), { code: "EEXIST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  let token = 0;
  fixture.createAuthorityToken.mockImplementation(() => `token-${++token}`);
  fixture.existsSync.mockReturnValue(true);
  fixture.fork.mockReturnValue(sentinel());
  fixture.openSync.mockImplementation((path: string) => {
    if (path === "/lifecycle.lock") throw eexist();
    return 10;
  });
  fixture.readFileSync.mockImplementation((path: string) => {
    if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
    if (path === "/recovery.lock") return JSON.stringify({ version: 1, token: "token-2", createdAt: 0 });
    if (path === "/heartbeat") return "0";
    if (path.startsWith("/recovery.lock.expired.")) return "expired";
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  fixture.requestAuthority.mockRejectedValue(new Error("no authority"));
  fixture.statSync.mockReturnValue({ mtimeMs: 0 });
});

describe("lifecycle lock fail-closed edges", () => {
  it("bounds sentinel diagnostics and cleans its owned lock after an early exit", async () => {
    const child = sentinel();
    fixture.openSync.mockReturnValue(10);
    fixture.fork.mockReturnValue(child);
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify({
        ...staleRecord("token-1"),
        heartbeatPath: "/self/.lifecycle-heartbeat.uuid",
      });
      return "0";
    });
    child.send.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.write(`${"x".repeat(5_000)}\nroot cause\n`);
        child.emit("exit", 2, null);
      });
      return true;
    });

    await expect(acquireLifecycleReservation()).rejects.toThrow("sentinel exited");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(fixture.unlinkSync).toHaveBeenCalledWith("/lifecycle.lock");
    expect(fixture.unlinkSync).toHaveBeenCalledWith("/self/.lifecycle-heartbeat.uuid");
  });

  it("rejects a sentinel process error", async () => {
    const child = sentinel();
    fixture.openSync.mockReturnValue(10);
    fixture.fork.mockReturnValue(child);
    child.send.mockImplementation(() => {
      setImmediate(() => child.emit("error", new Error("fork broke")));
      return true;
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("fork broke");
  });

  it("times out a silent sentinel and includes its bounded stderr tail", async () => {
    vi.useFakeTimers();
    const child = sentinel();
    fixture.openSync.mockReturnValue(10);
    fixture.fork.mockReturnValue(child);
    child.send.mockImplementation(() => {
      child.stderr.write("silent diagnostic\n");
      return true;
    });
    const pending = acquireLifecycleReservation();
    const rejected = expect(pending).rejects.toThrow(/did not start.*silent diagnostic/s);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    vi.useRealTimers();
  });

  it("ignores malformed sentinel messages before accepting an exact acquisition", async () => {
    const child = sentinel();
    fixture.openSync.mockReturnValue(10);
    fixture.fork.mockReturnValue(child);
    child.send.mockImplementation(() => {
      setImmediate(() => {
        child.emit("message", { type: "acquired", status: {} });
        child.emit("message", { type: "acquired", status: { supervisorPid: child.pid } });
      });
      return true;
    });
    const reservation = await acquireLifecycleReservation();
    fixture.readFileSync.mockReturnValue(JSON.stringify({
      ...staleRecord(reservation.token),
      heartbeatPath: reservation.heartbeatPath,
    }));
    fixture.requestAuthority.mockResolvedValue({ ok: true });
    await releaseLifecycleReservation(reservation);
    expect(reservation.sentinel.disconnect).toHaveBeenCalledOnce();
  });

  it("fails safely when both lock snapshot reads and heartbeat metadata disappear", async () => {
    fixture.readFileSync.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    fixture.statSync.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("exhausts crashed recovery-lease retries when the lease cannot be reread", async () => {
    fixture.openSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock" || path === "/recovery.lock") throw eexist();
      return 10;
    });
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
      if (path === "/heartbeat") return "0";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    fixture.statSync.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("surfaces an unexpected recovery-lease open failure", async () => {
    fixture.openSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") throw eexist();
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("denied");
  });

  it("restores a replaced recovery lease before retrying", async () => {
    let recoveryOpens = 0;
    fixture.existsSync.mockImplementation((path: string) => path !== "/recovery.lock");
    fixture.openSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") throw eexist();
      recoveryOpens += 1;
      if (recoveryOpens === 1) throw eexist();
      return 10;
    });
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
      if (path === "/heartbeat") return "0";
      if (path === "/recovery.lock") return recoveryOpens === 1
        ? JSON.stringify({ version: 1, token: "expired", createdAt: 0 })
        : JSON.stringify({ version: 1, token: "token-3", createdAt: 0 });
      if (path.startsWith("/recovery.lock.expired.")) return "replacement";
      throw new Error("unexpected path");
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
    expect(fixture.renameSync).toHaveBeenCalledWith("/recovery.lock.expired.token-2", "/recovery.lock");
  });

  it("surfaces a non-racy recovery quarantine failure", async () => {
    fixture.openSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock" || path === "/recovery.lock") throw eexist();
      return 10;
    });
    fixture.renameSync.mockImplementation(() => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
    await expect(acquireLifecycleReservation()).rejects.toThrow("rename denied");
  });

  it("abandons recovery if the observed lock changes before quarantine", async () => {
    let lockReads = 0;
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") {
        lockReads += 1;
        return JSON.stringify(staleRecord(lockReads >= 3 ? "replacement" : "old-token"));
      }
      if (path === "/recovery.lock") return JSON.stringify({ version: 1, token: "token-2", createdAt: 0 });
      if (path === "/heartbeat") return "0";
      throw new Error("unexpected path");
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("abandons recovery when authority becomes live after the lease is acquired", async () => {
    fixture.requestAuthority
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({ runId: "old-token", service: "lifecycle" });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("abandons recovery when the heartbeat refreshes under its lease", async () => {
    let heartbeatReads = 0;
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
      if (path === "/recovery.lock") return JSON.stringify({ version: 1, token: "token-2", createdAt: 0 });
      if (path === "/heartbeat") {
        heartbeatReads += 1;
        return heartbeatReads === 1 ? "0" : String(Date.now());
      }
      throw new Error("unexpected path");
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("abandons recovery if its lease token changes before unlink", async () => {
    let recoveryReads = 0;
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
      if (path === "/recovery.lock") {
        recoveryReads += 1;
        return JSON.stringify({
          version: 1,
          token: recoveryReads === 1 ? "token-2" : "replacement",
          createdAt: 0,
        });
      }
      if (path === "/heartbeat") return "0";
      throw new Error("unexpected path");
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not safely recover");
  });

  it("exhausts acquisition retries when every stale lock reclaim succeeds but creation keeps losing", async () => {
    let latestToken = "";
    let token = 0;
    fixture.createAuthorityToken.mockImplementation(() => {
      latestToken = `token-${++token}`;
      return latestToken;
    });
    fixture.readFileSync.mockImplementation((path: string) => {
      if (path === "/lifecycle.lock") return JSON.stringify(staleRecord());
      if (path === "/recovery.lock") return JSON.stringify({ version: 1, token: latestToken, createdAt: 0 });
      if (path === "/heartbeat") return "0";
      throw new Error("unexpected path");
    });
    await expect(acquireLifecycleReservation()).rejects.toThrow("could not acquire the Alook lifecycle reservation");
  });
});
