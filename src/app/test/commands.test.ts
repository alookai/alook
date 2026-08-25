import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVICE_PROFILE } from "../src/lib/constants.js";

const mocks = vi.hoisted(() => ({
  acquireLifecycleReservation: vi.fn(),
  checkPorts: vi.fn(),
  clearRegistry: vi.fn(),
  inspectServices: vi.fn(),
  installBundled: vi.fn(),
  installOwnedSignalCleanup: vi.fn(),
  markReservationReleased: vi.fn(),
  disposeSignalCleanup: vi.fn(),
  isInstalled: vi.fn(() => true),
  releaseLifecycleReservation: vi.fn(),
  runEmbeddedDaemon: vi.fn(),
  startSavedDaemons: vi.fn(() => ({ started: [], failed: [] })),
  startServices: vi.fn(),
  stopSavedDaemons: vi.fn(() => ({ stopped: [], failed: [] })),
  stopServices: vi.fn(),
  ensureSecrets: vi.fn(),
  patchWranglerConfigs: vi.fn(),
  runMigrations: vi.fn(),
  validateServicePortProfile: vi.fn(),
  waitForExistingServices: vi.fn(),
  waitForOwnedServices: vi.fn(),
}));

vi.mock("../src/lib/checks.js", () => ({
  checkPorts: mocks.checkPorts,
  validateServicePortProfile: mocks.validateServicePortProfile,
}));
vi.mock("../src/lib/install.js", () => ({
  installBundled: mocks.installBundled,
  isInstalled: mocks.isInstalled,
}));
vi.mock("../src/lib/secrets.js", () => ({ ensureSecrets: mocks.ensureSecrets }));
vi.mock("../src/lib/migrate.js", () => ({ runMigrations: mocks.runMigrations }));
vi.mock("../src/lib/wrangler-config.js", () => ({ patchWranglerConfigs: mocks.patchWranglerConfigs }));
vi.mock("../src/lib/services.js", () => ({
  inspectServices: mocks.inspectServices,
  startServices: mocks.startServices,
  stopServices: mocks.stopServices,
}));
vi.mock("../src/lib/startup.js", () => ({
  installOwnedSignalCleanup: mocks.installOwnedSignalCleanup,
  waitForExistingServices: mocks.waitForExistingServices,
  waitForOwnedServices: mocks.waitForOwnedServices,
}));
vi.mock("../src/lib/lifecycle-lock.js", () => ({
  acquireLifecycleReservation: mocks.acquireLifecycleReservation,
  releaseLifecycleReservation: mocks.releaseLifecycleReservation,
}));
vi.mock("../src/lib/pid.js", () => ({ clearRegistry: mocks.clearRegistry }));
vi.mock("../src/lib/daemon.js", () => ({
  runEmbeddedDaemon: mocks.runEmbeddedDaemon,
  startSavedDaemons: mocks.startSavedDaemons,
  stopSavedDaemons: mocks.stopSavedDaemons,
}));

import { daemonCommand } from "../src/commands/daemon.js";
import { startCommand } from "../src/commands/start.js";
import { stopCommand } from "../src/commands/stop.js";
import { updateCommand } from "../src/commands/update.js";

const reservation = { token: "reservation" };
const handle = { runId: "run" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALOOK_PROJECT_ROOT;
  mocks.acquireLifecycleReservation.mockResolvedValue(reservation);
  mocks.inspectServices.mockResolvedValue({ state: "none" });
  mocks.isInstalled.mockReturnValue(true);
  mocks.runEmbeddedDaemon.mockReturnValue({ ok: true, stdout: "", stderr: "" });
  mocks.startSavedDaemons.mockReturnValue({ started: [], failed: [] });
  mocks.installOwnedSignalCleanup.mockReturnValue({
    markReservationReleased: mocks.markReservationReleased,
    dispose: mocks.disposeSignalCleanup,
  });
  mocks.startServices.mockImplementation(async (_profile, options) => {
    options?.onHandle?.(handle);
    return handle;
  });
  mocks.stopSavedDaemons.mockReturnValue({ stopped: [], failed: [] });
  mocks.stopServices.mockResolvedValue({ stopped: true, errors: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon command", () => {
  it.each([
    [["start", "--machine-key", "cmt_pair"], ["start", "--machine-key", "cmt_pair"]],
    [["stop", "cm_machine"], ["stop", "cm_machine"]],
    [["list", "--json"], ["list", "--json"]],
    [["status", "cm_machine"], ["status", "cm_machine"]],
  ])("delegates %j to the embedded daemon", async (cliArgs, daemonArgs) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);

    await expect(daemonCommand().parseAsync(cliArgs, { from: "user" })).rejects.toThrow("exit:0");
    expect(mocks.runEmbeddedDaemon).toHaveBeenCalledWith(daemonArgs);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits non-zero when the embedded daemon fails", async () => {
    mocks.runEmbeddedDaemon.mockReturnValue({ ok: false, stdout: "", stderr: "failed" });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);

    await expect(daemonCommand().parseAsync(["list"], { from: "user" })).rejects.toThrow("exit:1");
  });
});

describe("start command", () => {
  it("requires onboarding before starting services", async () => {
    mocks.isInstalled.mockReturnValue(false);

    await expect(startCommand().parseAsync([], { from: "user" })).rejects.toThrow("Alook not installed");
    expect(mocks.acquireLifecycleReservation).not.toHaveBeenCalled();
  });

  it("uses one eight-port profile for preflight, spawn, readiness, and daemon restart", async () => {
    mocks.startSavedDaemons.mockReturnValue({ started: [], failed: ["cm_failed"] });

    await startCommand().parseAsync([], { from: "user" });

    expect(mocks.validateServicePortProfile).toHaveBeenCalledWith(DEFAULT_SERVICE_PROFILE);
    expect(mocks.checkPorts).toHaveBeenCalledWith(DEFAULT_SERVICE_PROFILE);
    expect(mocks.startServices).toHaveBeenCalledWith(DEFAULT_SERVICE_PROFILE, expect.objectContaining({
      foreground: false,
      onHandle: expect.any(Function),
    }));
    expect(mocks.waitForOwnedServices).toHaveBeenCalledWith(handle);
    expect(mocks.startSavedDaemons).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith("Could not start daemon(s): cm_failed");
    expect(mocks.releaseLifecycleReservation).toHaveBeenCalledWith(reservation);
    expect(mocks.markReservationReleased).toHaveBeenCalledOnce();
    expect(mocks.disposeSignalCleanup).toHaveBeenCalledOnce();
  });

  it("revalidates all four endpoints and does not spawn for an exact reusable owner", async () => {
    const registry = { profile: DEFAULT_SERVICE_PROFILE };
    mocks.inspectServices.mockResolvedValue({ state: "reusable", registry });

    await startCommand().parseAsync([], { from: "user" });

    expect(mocks.checkPorts).not.toHaveBeenCalled();
    expect(mocks.startServices).not.toHaveBeenCalled();
    expect(mocks.waitForExistingServices).toHaveBeenCalledWith(registry);
  });

  it("fails fast for a partial generation without spawning or cleaning it", async () => {
    mocks.inspectServices.mockResolvedValue({ state: "partial", detail: "wsDo exited" });
    await expect(startCommand().parseAsync([], { from: "user" })).rejects.toThrow(/partial.*npx @alook\/app stop/s);
    expect(mocks.startServices).not.toHaveBeenCalled();
    expect(mocks.releaseLifecycleReservation).toHaveBeenCalledWith(reservation);
  });

  it("clears a stale registry before starting a replacement", async () => {
    mocks.inspectServices.mockResolvedValue({ state: "stale", registry: { runId: "old" } });

    await startCommand().parseAsync([], { from: "user" });

    expect(mocks.clearRegistry).toHaveBeenCalledWith("old");
    expect(mocks.startServices).toHaveBeenCalledOnce();
  });
});

describe("stop command", () => {
  it("includes saved-daemon failures in the global failure result", async () => {
    mocks.stopSavedDaemons.mockReturnValue({ stopped: [], failed: ["cm_failed"] });

    await expect(stopCommand().parseAsync([], { from: "user" })).rejects.toThrow("daemon cm_failed did not stop");
    expect(mocks.stopServices).toHaveBeenCalledOnce();
    expect(mocks.releaseLifecycleReservation).toHaveBeenCalledWith(reservation);
  });

  it("prints global success only after services and daemons both stop", async () => {
    await stopCommand().parseAsync([], { from: "user" });
    expect(console.log).toHaveBeenCalledWith("\nAll services stopped.");
  });

  it("reports when no verified services were running", async () => {
    mocks.stopServices.mockResolvedValue({ stopped: false, errors: [] });

    await stopCommand().parseAsync([], { from: "user" });

    expect(console.log).toHaveBeenCalledWith("No verified running services found.");
  });
});

describe("update command", () => {
  it("rejects an inconsistent generation before installation", async () => {
    mocks.inspectServices.mockResolvedValue({ state: "profile-mismatch", detail: "port drift" });

    await expect(updateCommand().parseAsync([], { from: "user" })).rejects.toThrow(/profile-mismatch.*port drift/s);
    expect(mocks.installBundled).not.toHaveBeenCalled();
  });

  it("preserves a running generation's exact custom profile across stop and restart", async () => {
    const custom = structuredClone(DEFAULT_SERVICE_PROFILE);
    custom.web.business = 35210;
    const registry = { runId: "old", profile: custom };
    mocks.inspectServices.mockResolvedValue({ state: "reusable", registry });

    await updateCommand().parseAsync([], { from: "user" });

    expect(mocks.stopServices).toHaveBeenCalledOnce();
    expect(mocks.ensureSecrets).toHaveBeenCalledWith(custom.web.business);
    expect(mocks.patchWranglerConfigs).toHaveBeenCalledWith(custom);
    expect(mocks.checkPorts).toHaveBeenCalledWith(custom);
    expect(mocks.startServices).toHaveBeenCalledWith(custom, expect.objectContaining({ onHandle: expect.any(Function) }));
    expect(mocks.waitForOwnedServices).toHaveBeenCalledWith(handle);
  });

  it("does not install or restart when the current owned generation cannot fully stop", async () => {
    mocks.inspectServices.mockResolvedValue({ state: "reusable", registry: { runId: "old", profile: DEFAULT_SERVICE_PROFILE } });
    mocks.stopServices.mockResolvedValue({ stopped: false, errors: ["authority mismatch"] });
    await expect(updateCommand().parseAsync([], { from: "user" })).rejects.toThrow("authority mismatch");
    expect(mocks.installBundled).not.toHaveBeenCalled();
    expect(mocks.startServices).not.toHaveBeenCalled();
  });

  it("clears a stale registry and installs without restarting services", async () => {
    mocks.inspectServices.mockResolvedValue({ state: "stale", registry: { runId: "old" } });

    await updateCommand().parseAsync([], { from: "user" });

    expect(mocks.clearRegistry).toHaveBeenCalledWith("old");
    expect(mocks.installBundled).toHaveBeenCalledOnce();
    expect(mocks.startServices).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("Run 'npx @alook/app start' to start services.");
  });

  it("installs without stopping when no services are running", async () => {
    await updateCommand().parseAsync([], { from: "user" });

    expect(mocks.stopServices).not.toHaveBeenCalled();
    expect(mocks.installBundled).toHaveBeenCalledOnce();
    expect(mocks.startServices).not.toHaveBeenCalled();
  });
});
