import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertInstallationComplete: vi.fn(),
  checkNodeVersion: vi.fn(),
  checkPorts: vi.fn(),
  createInterface: vi.fn(),
  ensureSecrets: vi.fn(),
  getMissingInstallFiles: vi.fn(() => ["wake-worker/wrangler.toml"]),
  installBundled: vi.fn(),
  isInstalled: vi.fn(() => false),
  isRunning: vi.fn(() => false),
  patchWranglerConfigs: vi.fn(),
  runMigrations: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  startServices: vi.fn(),
  waitForServer: vi.fn(),
}));

vi.mock("child_process", () => ({ execSync: vi.fn(), spawn: mocks.spawn }));
vi.mock("readline", () => ({ createInterface: mocks.createInterface }));
vi.mock("../src/lib/checks.js", () => ({
  checkNodeVersion: mocks.checkNodeVersion,
  checkPorts: mocks.checkPorts,
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
  isRunning: mocks.isRunning,
  startServices: mocks.startServices,
}));
vi.mock("../src/lib/register.js", () => ({ waitForServer: mocks.waitForServer }));
vi.mock("../src/lib/wrangler-config.js", () => ({ patchWranglerConfigs: mocks.patchWranglerConfigs }));
vi.mock("../src/lib/daemon.js", () => ({ pairAndStartDaemon: vi.fn() }));

import { onboardCommand } from "../src/commands/onboard.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALOOK_PROJECT_ROOT;
  mocks.getMissingInstallFiles.mockReturnValue(["wake-worker/wrangler.toml"]);
  mocks.isInstalled.mockReturnValue(false);
  mocks.isRunning.mockReturnValue(false);
  mocks.createInterface.mockReturnValue({
    close: vi.fn(),
    question: vi.fn((_prompt: string, callback: () => void) => callback()),
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onboard command installation repair", () => {
  it("repairs and verifies an incomplete installation before patching configs", async () => {
    await onboardCommand().parseAsync(["--skip-register"], { from: "user" });

    expect(mocks.installBundled).toHaveBeenCalledOnce();
    expect(mocks.assertInstallationComplete).toHaveBeenCalledOnce();
    expect(mocks.installBundled.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertInstallationComplete.mock.invocationCallOrder[0],
    );
    expect(mocks.assertInstallationComplete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.patchWranglerConfigs.mock.invocationCallOrder[0],
    );
  });

  it("does not copy the bundle when the installation is complete", async () => {
    mocks.isInstalled.mockReturnValue(true);
    mocks.getMissingInstallFiles.mockReturnValue([]);

    await onboardCommand().parseAsync(["--skip-register"], { from: "user" });

    expect(mocks.installBundled).not.toHaveBeenCalled();
    expect(mocks.assertInstallationComplete).toHaveBeenCalledOnce();
    expect(mocks.patchWranglerConfigs).toHaveBeenCalledOnce();
  });
});
