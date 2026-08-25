import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVICE_PROFILE } from "../src/lib/constants.js";

const mocks = vi.hoisted(() => ({
  acquireLifecycleReservation: vi.fn(),
  assertInstallationComplete: vi.fn(),
  checkNodeVersion: vi.fn(),
  checkPorts: vi.fn(),
  clearRegistry: vi.fn(),
  createInterface: vi.fn(),
  ensureSecrets: vi.fn(),
  execSync: vi.fn(),
  getMissingInstallFiles: vi.fn(() => ["wake-worker/wrangler.toml"]),
  inspectServices: vi.fn(),
  installBundled: vi.fn(),
  installOwnedSignalCleanup: vi.fn(),
  markReservationReleased: vi.fn(),
  disposeSignalCleanup: vi.fn(),
  isInstalled: vi.fn(() => false),
  pairAndStartDaemon: vi.fn(),
  patchWranglerConfigs: vi.fn(),
  releaseLifecycleReservation: vi.fn(),
  runMigrations: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  startServices: vi.fn(),
  validateServicePortProfile: vi.fn(),
  waitForExistingServices: vi.fn(),
  waitForOwnedServices: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execSync: mocks.execSync, spawn: mocks.spawn }));
vi.mock("node:readline", () => ({ createInterface: mocks.createInterface }));
vi.mock("../src/lib/checks.js", () => ({
  checkNodeVersion: mocks.checkNodeVersion,
  checkPorts: mocks.checkPorts,
  validateServicePortProfile: mocks.validateServicePortProfile,
}));
vi.mock("../src/lib/install.js", () => ({
  assertInstallationComplete: mocks.assertInstallationComplete,
  getMissingInstallFiles: mocks.getMissingInstallFiles,
  installBundled: mocks.installBundled,
  isInstalled: mocks.isInstalled,
}));
vi.mock("../src/lib/secrets.js", () => ({ ensureSecrets: mocks.ensureSecrets }));
vi.mock("../src/lib/migrate.js", () => ({ runMigrations: mocks.runMigrations }));
vi.mock("../src/lib/services.js", () => ({
  inspectServices: mocks.inspectServices,
  startServices: mocks.startServices,
}));
vi.mock("../src/lib/register.js", () => ({
  collectEmail: vi.fn(),
  createPairingToken: vi.fn(),
  registerUser: vi.fn(),
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
vi.mock("../src/lib/wrangler-config.js", () => ({ patchWranglerConfigs: mocks.patchWranglerConfigs }));
vi.mock("../src/lib/daemon.js", () => ({ pairAndStartDaemon: mocks.pairAndStartDaemon }));

import { onboardCommand } from "../src/commands/onboard.js";

const reservation = { token: "reservation" };
const handle = { runId: "run" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALOOK_PROJECT_ROOT;
  mocks.acquireLifecycleReservation.mockResolvedValue(reservation);
  mocks.getMissingInstallFiles.mockReturnValue(["wake-worker/wrangler.toml"]);
  mocks.inspectServices.mockResolvedValue({ state: "none" });
  mocks.isInstalled.mockReturnValue(false);
  mocks.installOwnedSignalCleanup.mockReturnValue({
    markReservationReleased: mocks.markReservationReleased,
    dispose: mocks.disposeSignalCleanup,
  });
  mocks.startServices.mockImplementation(async (_profile, options) => {
    options?.onHandle?.(handle);
    return handle;
  });
  mocks.createInterface.mockReturnValue({
    close: vi.fn(),
    question: vi.fn((_prompt: string, callback: () => void) => callback()),
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onboard command", () => {
  it("repairs and verifies an incomplete installation before config, migrations, and spawn", async () => {
    await onboardCommand().parseAsync(["--skip-register", "--no-open"], { from: "user" });

    expect(mocks.installBundled).toHaveBeenCalledOnce();
    expect(mocks.assertInstallationComplete).toHaveBeenCalledOnce();
    expect(mocks.installBundled.mock.invocationCallOrder[0]).toBeLessThan(mocks.assertInstallationComplete.mock.invocationCallOrder[0]);
    expect(mocks.assertInstallationComplete.mock.invocationCallOrder[0]).toBeLessThan(mocks.patchWranglerConfigs.mock.invocationCallOrder[0]);
    expect(mocks.patchWranglerConfigs).toHaveBeenCalledWith(DEFAULT_SERVICE_PROFILE);
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.startServices).toHaveBeenCalledWith(DEFAULT_SERVICE_PROFILE, expect.objectContaining({
      foreground: false,
      onHandle: expect.any(Function),
    }));
    expect(mocks.waitForOwnedServices).toHaveBeenCalledWith(handle);
    expect(mocks.installOwnedSignalCleanup).toHaveBeenCalledWith(handle, reservation);
    expect(mocks.markReservationReleased).toHaveBeenCalledOnce();
    expect(mocks.disposeSignalCleanup).toHaveBeenCalledOnce();
  });

  it("does not copy a complete installation and still revalidates it", async () => {
    mocks.isInstalled.mockReturnValue(true);
    mocks.getMissingInstallFiles.mockReturnValue([]);

    await onboardCommand().parseAsync(["--skip-register", "--no-open"], { from: "user" });

    expect(mocks.installBundled).not.toHaveBeenCalled();
    expect(mocks.assertInstallationComplete).toHaveBeenCalledOnce();
    expect(mocks.patchWranglerConfigs).toHaveBeenCalledOnce();
  });

  it("makes --no-open a hard no-prompt/no-clipboard/no-browser contract", async () => {
    await onboardCommand().parseAsync(["--skip-register", "--no-open"], { from: "user" });
    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it("reuses only an exact healthy generation without install/config/spawn mutation", async () => {
    const registry = { profile: DEFAULT_SERVICE_PROFILE };
    mocks.inspectServices.mockResolvedValue({ state: "reusable", registry });
    await onboardCommand().parseAsync(["--skip-register", "--no-open"], { from: "user" });
    expect(mocks.waitForExistingServices).toHaveBeenCalledWith(registry);
    expect(mocks.installBundled).not.toHaveBeenCalled();
    expect(mocks.patchWranglerConfigs).not.toHaveBeenCalled();
    expect(mocks.startServices).not.toHaveBeenCalled();
  });
});
