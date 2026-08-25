import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const fixture = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/alook-test-services-${process.pid}`;
  return {
    dir,
    pidFile: `${dir}/.pids.json`,
    checkPort: vi.fn(() => Promise.resolve(true)),
    requestAuthority: vi.fn(),
    fork: vi.fn(),
    wranglerProcess: vi.fn(() => ({ command: "node", args: ["wrangler"] })),
  };
});

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: fixture.dir,
  PID_FILE: fixture.pidFile,
  SERVICE_NAMES: ["web", "emailWorker", "wsDo", "wakeWorker"],
}));
vi.mock("node:child_process", () => ({ fork: fixture.fork }));
vi.mock("../src/lib/control-authority.js", () => ({
  SUPERVISOR_ACQUISITION_BUDGET_MS: 1_000,
  createAuthorityToken: vi.fn(() => "token"),
  createControlEndpoint: vi.fn(() => "endpoint"),
  requestAuthority: fixture.requestAuthority,
  supervisorEntryPath: vi.fn(() => "/fixture/supervisor.js"),
}));
vi.mock("../src/lib/wrangler.js", () => ({
  wranglerProcess: fixture.wranglerProcess,
}));
vi.mock("../src/lib/checks.js", () => ({ checkPort: fixture.checkPort }));

import { clearRegistry, readRegistry, writeRegistry, type ServiceRegistry } from "../src/lib/pid.js";
import {
  createServiceCommand,
  handleMatchesRegistry,
  inspectServices,
  markServicesReady,
  startServices,
  stopServices,
  terminateOwnedHandle,
  type OwnedServiceHandle,
} from "../src/lib/services.js";

const names = ["web", "emailWorker", "wsDo", "wakeWorker"] as const;

function supervisorChild(pid: number) {
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    connected: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  value.pid = pid;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.connected = true;
  value.send = vi.fn();
  value.kill = vi.fn(() => true);
  value.disconnect = vi.fn(() => {
    value.connected = false;
    value.emit("disconnect");
  });
  value.unref = vi.fn();
  return value;
}

function registry(runId = "run-one"): ServiceRegistry {
  const profile = {
    web: { business: 45210, inspector: 49229 },
    emailWorker: { business: 45211, inspector: 49231 },
    wsDo: { business: 45212, inspector: 49230 },
    wakeWorker: { business: 45213, inspector: 49232 },
  };
  return {
    version: 1,
    runId,
    phase: "ready",
    profile,
    services: Object.fromEntries(names.map((name, index) => [name, {
      name,
      authority: { pid: 900_000 + index, endpoint: `fixture-${name}`, token: `token-${name}` },
      childPid: 910_000 + index,
      childState: "running",
      businessPort: profile[name].business,
      inspectorPort: profile[name].inspector,
      healthUrl: `http://127.0.0.1:${profile[name].business}${name === "web" ? "/api/health" : "/health"}`,
      logPath: `/tmp/${name}.log`,
    }])) as ServiceRegistry["services"],
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

function matchingStatus(value: ServiceRegistry, token: string) {
  const name = names.find((candidate) => value.services[candidate]?.authority.token === token)!;
  const entry = value.services[name]!;
  return {
    ok: true,
    runId: value.runId,
    service: name,
    supervisorPid: entry.authority.pid,
    childPid: entry.childPid,
    childState: "running" as const,
  };
}

describe("service ownership state", () => {
  beforeEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
    mkdirSync(fixture.dir, { recursive: true });
    fixture.requestAuthority.mockReset();
    fixture.checkPort.mockReset();
    fixture.checkPort.mockResolvedValue(true);
    fixture.fork.mockReset();
    fixture.wranglerProcess.mockClear();
    let nextPid = 800_000;
    fixture.fork.mockImplementation(() => {
      const supervisor = supervisorChild(nextPid++);
      supervisor.send.mockImplementation(() => {
        setImmediate(() => supervisor.emit("message", {
          type: "acquired",
          status: {
            ok: true,
            runId: readRegistry()?.runId,
            service: names[supervisor.pid - 800_000],
            supervisorPid: supervisor.pid,
            childPid: supervisor.pid + 10_000,
            childState: "running",
          },
        }));
        return true;
      });
      return supervisor;
    });
  });

  afterEach(() => {
    clearRegistry(readRegistry()?.runId ?? "none");
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("distinguishes no registry from malformed recovery-required state", async () => {
    await expect(inspectServices()).resolves.toEqual({ state: "none" });
    writeFileSync(fixture.pidFile, "{}");
    await expect(inspectServices()).resolves.toMatchObject({ state: "recovery-required" });
  });

  it("passes every service's exact business and inspector ports to Wrangler", () => {
    const value = registry();
    for (const name of names) createServiceCommand(name, value.profile);
    expect(fixture.wranglerProcess).toHaveBeenCalledTimes(4);
    for (const name of names) {
      expect(fixture.wranglerProcess).toHaveBeenCalledWith(expect.arrayContaining([
        "--port",
        String(value.profile[name].business),
        "--inspector-port",
        String(value.profile[name].inspector),
      ]));
    }
  });

  it("reuses only four matching live authorities and the exact profile", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      expect(action).toBe("status");
      return Promise.resolve(matchingStatus(value, token));
    });
    await expect(inspectServices(value.profile)).resolves.toMatchObject({ state: "reusable" });
    const different = structuredClone(value.profile);
    different.web.business += 100;
    await expect(inspectServices(different)).resolves.toMatchObject({ state: "profile-mismatch" });
  });

  it("fails partial-live and starting generations instead of treating any PID as reusable", async () => {
    const value = registry();
    value.phase = "starting";
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }) => {
      if (token === "token-web") return Promise.resolve(matchingStatus(value, token));
      return Promise.reject(new Error("missing private endpoint"));
    });
    await expect(inspectServices(value.profile)).resolves.toMatchObject({ state: "partial" });
  });

  it("diagnoses missing, stopped, and live-but-unauthenticated owners", async () => {
    const missing = registry();
    delete missing.services.web;
    writeRegistry(missing);
    await expect(inspectServices()).resolves.toMatchObject({ state: "stale" });
    clearRegistry(missing.runId);

    const stopped = registry();
    writeRegistry(stopped);
    fixture.requestAuthority.mockImplementation(({ token }) => Promise.resolve({
      ...matchingStatus(stopped, token),
      childState: "stopped",
    }));
    await expect(inspectServices()).resolves.toMatchObject({ state: "partial", detail: expect.stringContaining("reports stopped") });
    clearRegistry(stopped.runId);

    const unauthenticated = registry();
    unauthenticated.services.web!.authority.pid = process.pid;
    writeRegistry(unauthenticated);
    fixture.requestAuthority.mockRejectedValue(new Error("no endpoint"));
    await expect(inspectServices()).resolves.toMatchObject({
      state: "partial",
      detail: expect.stringContaining("live PID without matching private authority"),
    });
  });

  it("classifies a fully dead verified registry as stale", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockRejectedValue(new Error("missing private endpoint"));
    await expect(inspectServices()).resolves.toMatchObject({ state: "stale" });
  });

  it("refuses a mismatched authority, preserves diagnostics, and never requests termination", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      if (action === "terminate") throw new Error("must not terminate");
      return Promise.resolve({ ...matchingStatus(value, token), runId: "replacement" });
    });
    const result = await stopServices();
    expect(result.stopped).toBe(false);
    expect(result.errors.join("\n")).toContain("private authority mismatch");
    expect(fixture.requestAuthority.mock.calls.every((call) => call[1] === "status")).toBe(true);
    expect(readRegistry()?.phase).toBe("recovery-required");
  });

  it("terminates each matching owner and clears only the same runId after eight ports drain", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      const status = matchingStatus(value, token);
      return Promise.resolve(action === "terminate" ? { ...status, childState: "stopped" } : status);
    });
    await expect(stopServices()).resolves.toEqual({ stopped: true, errors: [] });
    expect(fixture.requestAuthority.mock.calls.filter((call) => call[1] === "terminate")).toHaveLength(4);
    expect(readRegistry()).toBeUndefined();
  });

  it("waits for owned ports to drain before clearing the registry", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      const status = matchingStatus(value, token);
      return Promise.resolve(action === "terminate" ? { ...status, childState: "stopped" } : status);
    });
    fixture.checkPort.mockResolvedValueOnce(false).mockResolvedValue(true);

    await expect(stopServices()).resolves.toEqual({ stopped: true, errors: [] });
    expect(fixture.checkPort.mock.calls.length).toBeGreaterThan(16);
  });

  it("preserves recovery state when owned ports remain occupied", async () => {
    const value = registry();
    writeRegistry(value);
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      const status = matchingStatus(value, token);
      return Promise.resolve(action === "terminate" ? { ...status, childState: "stopped" } : status);
    });
    fixture.checkPort.mockResolvedValue(false);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 6_000;
      return now;
    });

    await expect(stopServices()).resolves.toMatchObject({
      stopped: false,
      errors: ["one or more owned business/inspector ports remained occupied after stop"],
    });
    expect(readRegistry()?.phase).toBe("recovery-required");
  });

  it("prevents a delayed old handle from matching a replacement generation", () => {
    const value = registry();
    const handle = {
      runId: value.runId,
      profile: value.profile,
      registry: value,
      supervisors: {},
      foreground: false,
    } satisfies OwnedServiceHandle;
    expect(handleMatchesRegistry(handle, value)).toBe(true);
    expect(handleMatchesRegistry(handle, registry("replacement"))).toBe(false);
    const tokenReplacement = structuredClone(value);
    tokenReplacement.services.web!.authority.token = "different";
    expect(handleMatchesRegistry(handle, tokenReplacement)).toBe(false);
  });

  it("acquires four supervisors, publishes ready, and disconnects only after persistence", async () => {
    const value = registry();
    const onHandle = vi.fn();
    const handle = await startServices(value.profile, { onHandle });
    expect(onHandle).toHaveBeenCalledWith(handle);
    expect(fixture.fork).toHaveBeenCalledTimes(4);
    expect(Object.keys(handle.registry.services)).toEqual(names);
    expect(readRegistry()?.phase).toBe("starting");

    markServicesReady(handle);
    expect(readRegistry()?.phase).toBe("ready");
    for (const name of names) {
      expect(handle.supervisors[name]?.child.disconnect).toHaveBeenCalledOnce();
      expect(handle.supervisors[name]?.child.unref).toHaveBeenCalledOnce();
    }
  });

  it("keeps foreground supervisor streams teed and connected after ready", async () => {
    const value = registry();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = await startServices(value.profile, { foreground: true });
    const web = handle.supervisors.web!.child;
    web.stdout?.emit("data", Buffer.from("out\n"));
    web.stderr?.emit("data", Buffer.from("err\n"));
    markServicesReady(handle);
    expect(stdout).toHaveBeenCalledWith("[web] out\n");
    expect(stderr).toHaveBeenCalledWith("[web] err\n");
    expect(web.disconnect).not.toHaveBeenCalled();
  });

  it("rejects pre-acquisition supervisor failures immediately with the bounded log tail", async () => {
    const value = registry();
    fixture.fork.mockImplementationOnce(() => {
      const supervisor = supervisorChild(810_000);
      supervisor.send.mockImplementation(() => {
        writeFileSync(`${fixture.dir}/logs/web.log`, `${"x".repeat(70 * 1024)}\nroot cause\n`);
        setImmediate(() => supervisor.emit("message", {
          type: "supervisor-error",
          status: {
            ok: false,
            runId: readRegistry()?.runId,
            service: "web",
            supervisorPid: supervisor.pid,
            childState: "error",
            error: "shim rejected",
          },
        }));
        return true;
      });
      return supervisor;
    });

    await expect(startServices(value.profile)).rejects.toThrow(/shim rejected.*stderr tail:.*root cause/s);
    expect(readRegistry()).toBeUndefined();
  });

  it("routes one post-acquisition child failure to the owned handle", async () => {
    const value = registry();
    const handle = await startServices(value.profile);
    const web = handle.supervisors.web!;
    const failureStatus = {
      ok: false,
      runId: handle.runId,
      service: "web",
      supervisorPid: web.entry.authority.pid,
      childPid: web.entry.childPid,
      childState: "exited" as const,
      exitCode: 1,
      exitSignal: null,
    };
    web.child.emit("message", { type: "child-exit", status: failureStatus });
    web.child.emit("message", { type: "child-exit", status: failureStatus });
    await expect(web.failure).resolves.toEqual(failureStatus);
  });

  it("converts a post-acquisition supervisor error into one owned failure", async () => {
    const handle = await startServices(registry().profile);
    const web = handle.supervisors.web!;
    web.child.emit("error", new Error("ipc broke"));
    await expect(web.failure).resolves.toMatchObject({ childState: "error", error: "ipc broke" });
  });

  it.each([
    ["error", (supervisor: ReturnType<typeof supervisorChild>) => supervisor.emit("error", new Error("fork failed")), "fork failed"],
    ["exit", (supervisor: ReturnType<typeof supervisorChild>) => supervisor.emit("exit", 2, null), "supervisor exited"],
    ["disconnect", (supervisor: ReturnType<typeof supervisorChild>) => supervisor.emit("disconnect"), "IPC disconnected"],
    ["malformed failure", (supervisor: ReturnType<typeof supervisorChild>) => {
      supervisor.emit("message", { type: "child-error" });
      supervisor.emit("message", { type: "child-error" });
    }, "malformed child-error"],
    ["malformed acquisition", (supervisor: ReturnType<typeof supervisorChild>) => supervisor.emit("message", {
      type: "acquired",
      status: { childPid: 0 },
    }), "malformed acquired"],
  ])("rejects a pre-acquisition supervisor %s", async (_label, emitFailure, expected) => {
    fixture.fork.mockImplementationOnce(() => {
      const supervisor = supervisorChild(810_100);
      supervisor.send.mockImplementation(() => {
        setImmediate(() => emitFailure(supervisor));
        return true;
      });
      return supervisor;
    });

    await expect(startServices(registry().profile)).rejects.toThrow(expected);
    expect(readRegistry()).toBeUndefined();
  });

  it("bounds acquisition timeout, handles a missing log tail, and kills after failed authority cleanup", async () => {
    vi.useFakeTimers();
    const supervisor = supervisorChild(810_200);
    fixture.fork.mockImplementationOnce(() => supervisor);
    fixture.requestAuthority.mockRejectedValue(new Error("no authority"));
    const pending = startServices(registry().profile);
    const rejected = expect(pending).rejects.toThrow("supervisor did not acquire authority");
    rmSync(`${fixture.dir}/logs/web.log`, { force: true });
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(supervisor.kill).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("ignores a duplicate acquired response after the first settlement", async () => {
    fixture.fork.mockImplementationOnce(() => {
      const supervisor = supervisorChild(810_300);
      supervisor.send.mockImplementation(() => {
        const status = {
          ok: true,
          runId: readRegistry()?.runId,
          service: "web",
          supervisorPid: supervisor.pid,
          childPid: supervisor.pid + 10_000,
          childState: "running",
        };
        setImmediate(() => {
          supervisor.emit("message", { type: "progress" });
          supervisor.emit("message", { type: "acquired", status });
          supervisor.emit("message", { type: "acquired", status });
        });
        return true;
      });
      return supervisor;
    });

    const handle = await startServices(registry().profile);
    expect(handle.supervisors.web?.entry.childPid).toBe(820_300);
  });

  it("refuses an existing registry before spawning and rejects stale handle cleanup", async () => {
    const value = registry();
    writeRegistry(value);
    await expect(startServices(value.profile)).rejects.toThrow("refusing to overwrite");
    expect(fixture.fork).not.toHaveBeenCalled();
    const stale = {
      runId: "stale",
      profile: value.profile,
      registry: { ...value, runId: "stale" },
      supervisors: {},
      foreground: false,
    } satisfies OwnedServiceHandle;
    await expect(terminateOwnedHandle(stale)).rejects.toThrow("no longer the current matching owner");
  });

  it("marks the current generation recovery-required when an owned shutdown fails", async () => {
    const value = registry();
    writeRegistry(value);
    const handle = {
      runId: value.runId,
      profile: value.profile,
      registry: value,
      supervisors: {},
      foreground: false,
    } satisfies OwnedServiceHandle;
    fixture.requestAuthority.mockImplementation(({ token }, action) => {
      if (action === "terminate") return Promise.reject(new Error("termination failed"));
      return Promise.resolve(matchingStatus(value, token));
    });
    await expect(terminateOwnedHandle(handle)).rejects.toThrow("termination failed");
    expect(readRegistry()?.phase).toBe("recovery-required");
  });

  it("refuses cleanup when a current entry no longer matches its authority status", async () => {
    const value = registry();
    writeRegistry(value);
    const handle = {
      runId: value.runId,
      profile: value.profile,
      registry: value,
      supervisors: {},
      foreground: false,
    } satisfies OwnedServiceHandle;
    fixture.requestAuthority.mockImplementation(({ token }) => Promise.resolve({
      ...matchingStatus(value, token),
      childPid: -1,
    }));

    await expect(terminateOwnedHandle(handle)).rejects.toThrow("authority identity mismatch");
    expect(readRegistry()?.phase).toBe("recovery-required");
  });

  it("reports missing authorities and malformed registries during stop", async () => {
    writeFileSync(fixture.pidFile, "{}");
    await expect(stopServices()).resolves.toEqual({
      stopped: false,
      errors: ["PID registry is malformed or unverifiable"],
    });
    rmSync(fixture.pidFile, { force: true });
    await expect(stopServices()).resolves.toEqual({ stopped: false, errors: [] });

    const value = registry();
    delete value.services.web;
    writeRegistry(value);
    await expect(stopServices()).resolves.toMatchObject({
      stopped: false,
      errors: expect.arrayContaining(["web: missing private authority"]),
    });
  });
});
