import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
const paths = vi.hoisted(() => ({
  testDir: `/tmp/alook-app-daemon-${process.pid}`,
  daemonBaseDir: `/tmp/alook-app-daemon-${process.pid}/daemon`,
}));
const { testDir, daemonBaseDir } = paths;
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(),
  spawnSync,
}));
vi.mock("../src/lib/constants.js", () => ({
  DAEMON_BASE_DIR: paths.daemonBaseDir,
  WEB_URL: (port: number) => `http://localhost:${port}`,
  WS_URL: (port: number) => `ws://localhost:${port}`,
}));

import {
  listRunningDaemonIds,
  listSavedDaemonIds,
  pairAndStartDaemon,
  startSavedDaemons,
  stopSavedDaemons,
} from "../src/lib/daemon.js";

function result(stdout = "", status = 0) {
  return { stdout, stderr: "", status, error: undefined };
}

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(daemonBaseDir, "daemons"), { recursive: true });
  spawnSync.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("saved daemon discovery", () => {
  it("uses the embedded daemon's saved-machine envelope", () => {
    spawnSync.mockReturnValue(result(JSON.stringify({ success: { machineIds: ["cm_valid_machine"] } })));
    expect(listSavedDaemonIds()).toEqual(["cm_valid_machine"]);
    expect(spawnSync.mock.calls[0]![1]).toEqual(expect.arrayContaining(["daemon", "saved-machines", "--base-dir", daemonBaseDir]));
  });

  it.each([
    { stdout: JSON.stringify({ error: "directory unavailable" }), status: 0 },
    { stdout: "not JSON", status: 0 },
    { stdout: JSON.stringify({ success: {} }), status: 0 },
    { stdout: JSON.stringify({ success: { machineIds: ["../outside"] } }), status: 0 },
    { stdout: "", status: 1 },
  ])("does not silently skip saved machines after discovery failure: $stdout", ({ stdout, status }) => {
    spawnSync.mockReturnValue(result(stdout, status));
    expect(() => listSavedDaemonIds()).toThrow();
  });

  it("reads live ids from the daemon JSON envelope", () => {
    spawnSync.mockReturnValue(result(JSON.stringify({
      success: { daemons: [
        { id: "cm_live_machine", alive: true },
        { id: "cm_dead_machine", alive: false },
        { id: "../../bad", alive: true },
      ] },
    })));
    expect(listRunningDaemonIds()).toEqual(["cm_live_machine"]);
  });
});

describe("daemon lifecycle", () => {
  it("pairs against the local HTTP and WS services in the app-owned base dir", () => {
    spawnSync.mockReturnValue(result("daemon started\n"));
    expect(pairAndStartDaemon("cmt_pairing", { web: 15210, wsDo: 15212 })).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("node", expect.arrayContaining([
      "daemon", "start", "--machine-key", "cmt_pairing",
      "--server-url", "http://localhost:15210",
      "--ws-url", "ws://localhost:15212",
      "--base-dir", daemonBaseDir,
    ]), expect.any(Object));
  });

  it("starts saved but stopped machines and skips live ones", () => {
    spawnSync
      .mockReturnValueOnce(result(JSON.stringify({ success: { daemons: [{ id: "cm_live_machine", alive: true }] } })))
      .mockReturnValueOnce(result(JSON.stringify({ success: { machineIds: ["cm_live_machine", "cm_saved_machine"] } })))
      .mockReturnValueOnce(result("daemon started\n"));
    expect(startSavedDaemons()).toEqual({ started: ["cm_saved_machine"], failed: [] });
    expect(spawnSync.mock.calls[2]![1]).toEqual(expect.arrayContaining(["start", "--id", "cm_saved_machine"]));
  });

  it("stops every live app-owned daemon", () => {
    spawnSync
      .mockReturnValueOnce(result(JSON.stringify({ success: { daemons: [
        { id: "cm_first_machine", alive: true },
        { id: "cm_second_machine", alive: true },
      ] } })))
      .mockReturnValue(result("daemon stopped\n"));
    expect(stopSavedDaemons()).toEqual({
      stopped: ["cm_first_machine", "cm_second_machine"],
      failed: [],
    });
  });

  it("treats a JSON error envelope as failure even when the CLI exits zero", () => {
    spawnSync.mockReturnValue(result(JSON.stringify({ error: "activation failed" })));
    expect(pairAndStartDaemon("cmt_pairing", { web: 1, wsDo: 2 })).toBe(false);
  });
});
