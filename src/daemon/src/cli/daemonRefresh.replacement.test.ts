import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDaemonVersion } from "../version";

const boundary = vi.hoisted(() => ({
  readPidFile: vi.fn(), readDaemonLaunchRecord: vi.fn(), acquireDaemonReplacementLock: vi.fn(),
  stopExactDaemonPid: vi.fn(), daemonResume: vi.fn(), removeReplacementLockIfMatches: vi.fn(),
}));
vi.mock("./daemonStart.js", () => ({
  ...boundary, pidfilePathById: () => "fixture.pid", daemonProcessArguments: () => [],
}));
import { daemonRefreshFromIpc, replaceDaemonForRefresh } from "./daemonRefresh";

const requestId = "26aac14d-dfd6-4e96-821c-ebf538316f79";
const context = { baseDir: "/fixture", machineId: "cm_fixture", pid: 424242,
  startedAt: "2026-11-02T00:00:00Z", ownerToken: "fixture-owner" };
const savedEnvironment = { ...process.env };
const ipcProperties = new Map(["send", "connected", "disconnect"].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));
let priorMessageListeners: Set<ReturnType<typeof process.listeners>[number]>;
const input = () => ({ context, requestId, priorEnvironment: { ...savedEnvironment, ALOOK_REFRESH_FIXTURE: "prior" } });

beforeEach(() => {
  priorMessageListeners = new Set(process.listeners("message"));
  vi.resetAllMocks();
  boundary.readPidFile.mockReturnValue(context);
  boundary.readDaemonLaunchRecord.mockReturnValue({ daemonVersion: readDaemonVersion() });
  boundary.acquireDaemonReplacementLock.mockReturnValue({ path: "fixture.lock", lock: { requestId } });
  boundary.stopExactDaemonPid.mockResolvedValue(undefined);
  boundary.daemonResume.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  for (const [key, descriptor] of ipcProperties) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
  for (const listener of process.listeners("message")) if (!priorMessageListeners.has(listener)) process.removeListener("message", listener);
});

describe("Refresh replacement authority", () => {
  it.each(["version", "owner", "after-lock"])("does not stop a daemon after %s authority changes", async (change) => {
    if (change === "version") boundary.readDaemonLaunchRecord.mockReturnValue({ daemonVersion: "0.0.1" });
    if (change === "owner") boundary.readPidFile.mockReturnValue({ ...context, ownerToken: "successor" });
    if (change === "after-lock") boundary.readPidFile.mockReturnValueOnce(context).mockReturnValue({ ...context, pid: 424243 });
    await expect(replaceDaemonForRefresh(input())).rejects.toThrow("ownership_changed");
    expect(boundary.stopExactDaemonPid).not.toHaveBeenCalled();
    expect(boundary.daemonResume).not.toHaveBeenCalled();
    expect(boundary.removeReplacementLockIfMatches).toHaveBeenCalledTimes(change === "after-lock" ? 1 : 0);
  });

  it("stops only the verified PID, resumes once and releases replacement ownership", async () => {
    await replaceDaemonForRefresh(input());
    expect(boundary.stopExactDaemonPid).toHaveBeenCalledExactlyOnceWith(context.pid);
    expect(boundary.daemonResume).toHaveBeenCalledExactlyOnceWith({ id: context.machineId,
      baseDir: context.baseDir, requestId, refreshResult: { requestId, status: "complete" } });
    expect(boundary.removeReplacementLockIfMatches).toHaveBeenCalledExactlyOnceWith("fixture.lock", { requestId });
  });

  it("rolls back once with the previous environment and never reports completion after startup failure", async () => {
    const environments: Array<NodeJS.ProcessEnv> = [];
    process.env.ALOOK_REFRESH_FIXTURE = "fresh";
    process.env.ALOOK_REFRESH_FRESH_ONLY = "fresh-only";
    boundary.daemonResume.mockImplementation(async () => {
      environments.push({ ...process.env });
      if (environments.length === 1) throw new Error("startup failed");
    });
    await replaceDaemonForRefresh(input());
    expect(environments[0].ALOOK_REFRESH_FIXTURE).toBe("fresh");
    expect(environments[1].ALOOK_REFRESH_FIXTURE).toBe("prior");
    expect(environments[1].ALOOK_REFRESH_FRESH_ONLY).toBeUndefined();
    expect(boundary.daemonResume).toHaveBeenCalledTimes(2);
    expect(boundary.daemonResume.mock.calls[1][0].refreshResult).toEqual({ requestId, status: "error", code: "restart_failed" });
    expect(boundary.removeReplacementLockIfMatches).toHaveBeenCalledOnce();
  });
});

function parentIpc() {
  const send = vi.fn((_message, callback) => callback());
  const disconnect = vi.fn(() => Object.defineProperty(process, "connected", { value: false, configurable: true }));
  Object.defineProperties(process, { send: { value: send, configurable: true },
    connected: { value: true, configurable: true }, disconnect: { value: disconnect, configurable: true } });
  return { send, disconnect };
}

function deliver(message: unknown): void {
  const listener = process.listeners("message").find((candidate) => !priorMessageListeners.has(candidate));
  if (!listener) throw new Error("missing fixture IPC listener");
  listener.call(process, message);
}

describe("Refresh helper IPC", () => {
  it("requires parent IPC and bounds absent input", async () => {
    Object.defineProperty(process, "connected", { value: false, configurable: true });
    await expect(daemonRefreshFromIpc()).rejects.toThrow("parent IPC");
    parentIpc();
    vi.useFakeTimers();
    const pending = expect(daemonRefreshFromIpc()).rejects.toThrow("input unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(boundary.stopExactDaemonPid).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...input(), context: { ...context, pid: 0 } }])("rejects malformed local input before replacement", async (message) => {
    parentIpc();
    const pending = expect(daemonRefreshFromIpc()).rejects.toThrow("invalid refresh input");
    deliver(message);
    await pending;
    expect(boundary.stopExactDaemonPid).not.toHaveBeenCalled();
  });

  it.each(["success", "ownership_changed", "restart_failed"])("disconnects after %s and reports only fixed failure metadata", async (outcome) => {
    const ipc = parentIpc();
    if (outcome === "ownership_changed") boundary.readPidFile.mockReturnValue(undefined);
    if (outcome === "restart_failed") boundary.daemonResume.mockRejectedValue(new Error("PRIVATE_STARTUP_DETAIL"));
    const pending = daemonRefreshFromIpc();
    deliver(input());
    await pending;
    expect(ipc.disconnect).toHaveBeenCalledOnce();
    if (outcome === "success") expect(ipc.send).not.toHaveBeenCalled();
    else expect(ipc.send).toHaveBeenCalledExactlyOnceWith({ requestId, status: "error", code: outcome }, expect.any(Function));
  });
});
