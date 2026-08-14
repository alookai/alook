import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPorts: vi.fn(),
  isInstalled: vi.fn(() => true),
  isRunning: vi.fn(() => false),
  runEmbeddedDaemon: vi.fn(),
  startSavedDaemons: vi.fn(() => ({ started: [], failed: [] })),
  startServices: vi.fn(),
  stopSavedDaemons: vi.fn(() => ({ stopped: [], failed: [] })),
  stopServices: vi.fn(),
  waitForServer: vi.fn(),
}));

vi.mock("../src/lib/checks.js", () => ({ checkPorts: mocks.checkPorts }));
vi.mock("../src/lib/install.js", () => ({ isInstalled: mocks.isInstalled }));
vi.mock("../src/lib/services.js", () => ({
  isRunning: mocks.isRunning,
  startServices: mocks.startServices,
  stopServices: mocks.stopServices,
}));
vi.mock("../src/lib/register.js", () => ({ waitForServer: mocks.waitForServer }));
vi.mock("../src/lib/daemon.js", () => ({
  runEmbeddedDaemon: mocks.runEmbeddedDaemon,
  startSavedDaemons: mocks.startSavedDaemons,
  stopSavedDaemons: mocks.stopSavedDaemons,
}));

import { daemonCommand } from "../src/commands/daemon.js";
import { startCommand } from "../src/commands/start.js";
import { stopCommand } from "../src/commands/stop.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isInstalled.mockReturnValue(true);
  mocks.isRunning.mockReturnValue(false);
  mocks.runEmbeddedDaemon.mockReturnValue({ ok: true, stdout: "", stderr: "" });
  mocks.startSavedDaemons.mockReturnValue({ started: [], failed: [] });
  mocks.stopSavedDaemons.mockReturnValue({ stopped: [], failed: [] });
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
  it("starts services, waits for web, and restarts saved daemons with all ports", async () => {
    mocks.startSavedDaemons.mockReturnValue({ started: [], failed: ["cm_failed"] });

    await startCommand().parseAsync([
      "--port-web", "15210",
      "--port-email", "15211",
      "--port-ws", "15212",
      "--port-wake", "15213",
    ], { from: "user" });

    const ports = { web: 15210, emailWorker: 15211, wsDo: 15212, wakeWorker: 15213 };
    expect(mocks.checkPorts).toHaveBeenCalledWith(ports);
    expect(mocks.startServices).toHaveBeenCalledWith(ports, { foreground: false });
    expect(mocks.waitForServer).toHaveBeenCalledWith("http://localhost:15210");
    expect(mocks.startSavedDaemons).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith("Could not start daemon(s): cm_failed");
  });

  it("only restarts daemons when services are already running", async () => {
    mocks.isRunning.mockReturnValue(true);

    await startCommand().parseAsync([], { from: "user" });

    expect(mocks.checkPorts).not.toHaveBeenCalled();
    expect(mocks.startServices).not.toHaveBeenCalled();
    expect(mocks.waitForServer).not.toHaveBeenCalled();
    expect(mocks.startSavedDaemons).toHaveBeenCalledOnce();
  });
});

describe("stop command", () => {
  it("stops app-owned daemons and services and reports daemon failures", async () => {
    mocks.stopSavedDaemons.mockReturnValue({ stopped: [], failed: ["cm_failed"] });

    await stopCommand().parseAsync([], { from: "user" });

    expect(mocks.stopSavedDaemons).toHaveBeenCalledOnce();
    expect(mocks.stopServices).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith("Could not stop daemon(s): cm_failed");
  });
});
