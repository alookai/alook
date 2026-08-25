import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AuthorityStatus } from "../src/lib/control-authority.js";
import type { OwnedServiceHandle } from "../src/lib/services.js";
import type { ServiceRegistry } from "../src/lib/pid.js";

const mocks = vi.hoisted(() => ({
  acquireLifecycleReservation: vi.fn(),
  markServicesReady: vi.fn(),
  readRegistry: vi.fn(() => ({ runId: "run" })),
  releaseLifecycleReservation: vi.fn(),
  terminateOwnedHandle: vi.fn(),
}));

vi.mock("../src/lib/services.js", () => ({
  handleMatchesRegistry: vi.fn(() => true),
  markServicesReady: mocks.markServicesReady,
  terminateOwnedHandle: mocks.terminateOwnedHandle,
}));
vi.mock("../src/lib/pid.js", () => ({ readRegistry: mocks.readRegistry }));
vi.mock("../src/lib/lifecycle-lock.js", () => ({
  acquireLifecycleReservation: mocks.acquireLifecycleReservation,
  releaseLifecycleReservation: mocks.releaseLifecycleReservation,
}));

import { installOwnedSignalCleanup, waitForExistingServices, waitForOwnedServices } from "../src/lib/startup.js";

const names = ["web", "emailWorker", "wsDo", "wakeWorker"] as const;

function fixtureRegistry(url: string): ServiceRegistry {
  const profile = {
    web: { business: 1, inspector: 11 },
    emailWorker: { business: 2, inspector: 12 },
    wsDo: { business: 3, inspector: 13 },
    wakeWorker: { business: 4, inspector: 14 },
  };
  return {
    version: 1,
    runId: "run",
    phase: "starting",
    profile,
    createdAt: "2026-08-25T00:00:00.000Z",
    services: Object.fromEntries(names.map((name, index) => [name, {
      name,
      authority: { pid: 100 + index, endpoint: name, token: name },
      childPid: 200 + index,
      childState: "running",
      businessPort: profile[name].business,
      inspectorPort: profile[name].inspector,
      healthUrl: `${url}${name === "web" ? "/api/health" : `/${name}/health`}`,
      logPath: `/logs/${name}.log`,
    }])) as ServiceRegistry["services"],
  };
}

function ownedHandle(registry: ServiceRegistry, failure?: Promise<AuthorityStatus>): OwnedServiceHandle {
  const never = new Promise<AuthorityStatus>(() => {});
  return {
    runId: registry.runId,
    profile: registry.profile,
    registry,
    foreground: false,
    supervisors: Object.fromEntries(names.map((name) => [name, {
      child: {} as never,
      entry: registry.services[name]!,
      failure: failure ?? never,
    }])) as OwnedServiceHandle["supervisors"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireLifecycleReservation.mockResolvedValue({ token: "fresh" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("four-service readiness", () => {
  it("requires exact 200 health from all four services before marking ready", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const registry = fixtureRegistry("http://fixture");
    const handle = ownedHandle(registry);
    await waitForOwnedServices(handle, 500);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      "http://fixture/api/health",
      "http://fixture/emailWorker/health",
      "http://fixture/wsDo/health",
      "http://fixture/wakeWorker/health",
    ]));
    expect(mocks.markServicesReady).toHaveBeenCalledWith(handle);
    expect(mocks.terminateOwnedHandle).not.toHaveBeenCalled();
  });

  it("retries unavailable health after the bounded polling delay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const readiness = waitForExistingServices(fixtureRegistry("http://fixture"), 2_000);
    await vi.advanceTimersByTimeAsync(500);
    await readiness;

    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("lets an exact child early exit win the readiness race and cleans only the owned handle", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const registry = fixtureRegistry("http://fixture");
    const failure = Promise.resolve({
      ok: false,
      runId: "run",
      service: "wsDo",
      supervisorPid: 1,
      childState: "exited" as const,
      exitCode: 23,
      exitSignal: null,
    });
    const handle = ownedHandle(registry, failure);
    await expect(waitForOwnedServices(handle, 5_000)).rejects.toThrow(
      /web exited before readiness.*code=23.*\/logs\/web\.log.*npx @alook\/app stop/s,
    );
    expect(mocks.terminateOwnedHandle).toHaveBeenCalledWith(handle);
  });

  it("bounds a TCP accept-without-response by the one total deadline", async () => {
    vi.unstubAllGlobals();
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const registry = fixtureRegistry(`http://127.0.0.1:${address.port}`);
    const handle = ownedHandle(registry);
    const started = Date.now();
    try {
      await expect(waitForOwnedServices(handle, 120)).rejects.toThrow(
        /web.*emailWorker.*wsDo.*wakeWorker.*npx @alook\/app stop/s,
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(mocks.terminateOwnedHandle).toHaveBeenCalledWith(handle);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails fast without spawn or cleanup when a ready generation returns non-200 health", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 }));
    const registry = fixtureRegistry("http://fixture");
    const started = Date.now();
    await expect(waitForExistingServices(registry, 5_000)).rejects.toThrow(
      /web health returned HTTP 503.*\/logs\/web\.log.*npx @alook\/app stop/s,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(mocks.terminateOwnedHandle).not.toHaveBeenCalled();
  });

  it("handles an expired deadline and missing service entries diagnostically", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const registry = fixtureRegistry("http://fixture");
    delete registry.services.web;
    await expect(waitForExistingServices(registry, 1)).rejects.toThrow("missing health URL");
  });

  it("reports pending services when the shared deadline expires between polling steps", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 11_000;
      return now;
    });
    const progress = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const registry = fixtureRegistry("http://fixture");

    await expect(waitForExistingServices(registry, 30_000)).rejects.toThrow("services did not become ready");
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("still starting"));
  });

  it("marks ready even when a supervisor failure promise is intentionally absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const registry = fixtureRegistry("http://fixture");
    const handle = ownedHandle(registry);
    delete handle.supervisors.web;
    await waitForOwnedServices(handle, 100);
    expect(mocks.markServicesReady).toHaveBeenCalledWith(handle);
  });

  it("reports both readiness and owned cleanup failures", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mocks.terminateOwnedHandle.mockRejectedValueOnce(new Error("cleanup failed"));
    const handle = ownedHandle(fixtureRegistry("http://fixture"), Promise.resolve({
      ok: false,
      runId: "run",
      service: "web",
      supervisorPid: 1,
      childState: "error",
      error: "startup failed",
    }));
    await expect(waitForOwnedServices(handle, 100)).rejects.toThrow("service startup and owned cleanup both failed");
  });
});

describe("owned signal cleanup", () => {
  it("uses the already-held reservation during startup and exits with the signal code", async () => {
    const initial = { token: "initial" } as never;
    const handle = ownedHandle(fixtureRegistry("http://fixture"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const controller = installOwnedSignalCleanup(handle, initial);
    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(mocks.acquireLifecycleReservation).not.toHaveBeenCalled();
    expect(mocks.terminateOwnedHandle).toHaveBeenCalledWith(handle);
    expect(mocks.releaseLifecycleReservation).toHaveBeenCalledWith(initial);
    controller.dispose();
  });

  it("reacquires a reservation after readiness before delayed foreground cleanup", async () => {
    const initial = { token: "initial" } as never;
    const fresh = { token: "fresh" } as never;
    mocks.acquireLifecycleReservation.mockResolvedValue(fresh);
    const handle = ownedHandle(fixtureRegistry("http://fixture"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const controller = installOwnedSignalCleanup(handle, initial);
    controller.markReservationReleased();
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(mocks.acquireLifecycleReservation).toHaveBeenCalledOnce();
    expect(mocks.releaseLifecycleReservation).toHaveBeenCalledWith(fresh);
    controller.dispose();
  });

  it("makes repeated signals single-settle and exits nonzero when cleanup fails", async () => {
    const initial = { token: "initial" } as never;
    const handle = ownedHandle(fixtureRegistry("http://fixture"));
    mocks.terminateOwnedHandle.mockRejectedValueOnce(new Error("cleanup failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const controller = installOwnedSignalCleanup(handle, initial);
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.terminateOwnedHandle).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("cleanup failed");
    controller.dispose();
  });
});
