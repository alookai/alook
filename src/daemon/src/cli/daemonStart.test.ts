import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { daemonStatus } from "./daemonStart";
import { credentialFilePathByMachineId, savedDaemonMachineIds } from "./daemonState";

describe("daemonStart — credentialFilePath by machineId", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemon-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("enumerates saved machine names without parsing credential contents", () => {
    expect(savedDaemonMachineIds({ baseDir })).toEqual([]);
    const directory = path.join(baseDir, "daemons");
    fs.mkdirSync(directory);
    for (const name of ["cm_zzzzzzzz.credential.json", "cm_abcdefgh.credential.json", "cm_x.credential.json", "notes.txt"]) {
      fs.writeFileSync(path.join(directory, name), "not JSON");
    }
    expect(savedDaemonMachineIds({ baseDir })).toEqual(["cm_abcdefgh", "cm_zzzzzzzz"]);
  });

  it("does not hide an unreadable saved-machine directory as an empty list", () => {
    fs.writeFileSync(path.join(baseDir, "daemons"), "not a directory");
    expect(() => savedDaemonMachineIds({ baseDir })).toThrow();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports permission failure while traversing the saved-machine directory", () => {
    const directory = path.join(baseDir, "daemons");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "cm_abcdefgh.credential.json"), "not JSON");
    expect(savedDaemonMachineIds({ baseDir })).toEqual(["cm_abcdefgh"]);
    const mode = fs.statSync(baseDir).mode & 0o777;
    try {
      fs.chmodSync(baseDir, 0);
      expect(() => savedDaemonMachineIds({ baseDir })).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally { fs.chmodSync(baseDir, mode); }
  });

  it("derives path from machineId, not from the CLI arg", () => {
    const machineId = "cm_abc12345";
    const p1 = credentialFilePathByMachineId(baseDir, machineId);
    const p2 = credentialFilePathByMachineId(baseDir, machineId);
    expect(p1).toBe(p2);
    expect(p1).toContain(`${machineId}.credential.json`);
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "cm_bad\\segment",
    `cm_${"a".repeat(65)}`,
  ])("rejects an unsafe machine id inside the exported path builder: %s", (machineId) => {
    expect(() => credentialFilePathByMachineId(baseDir, machineId)).toThrow(
      "invalid machine identity returned by server",
    );
  });
});

describe("daemonStatus — reads snapshot + always flags freshness (batch E2)", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-status-test-"));
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // Per-key layout (C0): status lives at daemons/<id>/status.json.
  const ID = "cm_status_test_123";
  const daemonSubdir = () => path.join(baseDir, "daemons", ID);
  const writeSnap = (writtenAt: number, agentSummary?: { total: number | null; running: number }) => {
    const dir = daemonSubdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        writtenAt,
        ...(agentSummary ? { agentSummary } : {}),
        agents: [
          { agentId: "a1", status: "running", derivedActivity: "idle", turnActive: false, inbox: 0, sinceProgressMs: 10, stoppingSince: null },
        ],
      }),
    );
  };

  it("missing file → freshness 'missing', found false, no throw", () => {
    const r = daemonStatus({ id: ID, baseDir, now: () => 1000 });
    expect(r.found).toBe(false);
    expect(r.freshness).toBe("missing");
    expect(r.agents).toEqual([]);
  });

  it("recent snapshot → 'fresh' with the agent projection + age", () => {
    writeSnap(1000, { total: 4, running: 2 });
    const r = daemonStatus({ id: ID, baseDir, now: () => 3000 }); // 2s old
    expect(r.found).toBe(true);
    expect(r.freshness).toBe("fresh");
    expect(r.ageMs).toBe(2000);
    expect(r.agentSummary).toEqual({ total: 4, running: 2 });
    expect(r.agents[0]?.agentId).toBe("a1");
    expect(r.agents[0]?.derivedActivity).toBe("idle");
  });

  it("keeps an unknown authoritative total distinct from zero", () => {
    writeSnap(1000, { total: null, running: 0 });
    const r = daemonStatus({ id: ID, baseDir, now: () => 1000 });

    expect(r.agentSummary).toEqual({ total: null, running: 0 });
  });

  it("recent snapshot resolvable WITHOUT an id when only one daemon exists (auto-pick)", () => {
    writeSnap(1000);
    const r = daemonStatus({ baseDir, now: () => 3000 });
    expect(r.found).toBe(true);
    expect(r.agents[0]?.agentId).toBe("a1");
  });

  it("old snapshot → 'stale' (never mistaken for live truth)", () => {
    writeSnap(1000);
    const r = daemonStatus({ id: ID, baseDir, now: () => 1000 + 60_000 }); // 60s old
    expect(r.freshness).toBe("stale");
    expect(r.ageMs).toBe(60_000);
    expect(r.found).toBe(true); // still returns the last-known frame
  });

  it("corrupt/half-written file → treated as missing, no throw", () => {
    const dir = daemonSubdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), "{ not valid json");
    const r = daemonStatus({ id: ID, baseDir, now: () => 1000 });
    expect(r.found).toBe(false);
    expect(r.freshness).toBe("missing");
  });

  it("multiple daemons + no id → ambiguous (per-daemon status can't guess which)", () => {
    // Two daemons each with their own status.json subdir.
    for (const id of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
      const dir = path.join(baseDir, "daemons", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ writtenAt: 1000, agents: [] }));
    }
    const r = daemonStatus({ baseDir, now: () => 1000 });
    expect(r.found).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.availableIds?.sort()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "cm_bad\\segment",
    `cm_${"a".repeat(65)}`,
  ])("rejects an unsafe explicit id before status-file access: %s", (id) => {
    expect(() => daemonStatus({ id, baseDir, now: () => 1000 })).toThrow("invalid daemon id");
  });

  it("ignores unsafe directory names when auto-selecting status", () => {
    writeSnap(1000);
    const unsafeDir = path.join(baseDir, "daemons", "not-a-daemon-id");
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(unsafeDir, "status.json"), JSON.stringify({ writtenAt: 1000, agents: [] }));
    const r = daemonStatus({ baseDir, now: () => 1000 });
    expect(r.found).toBe(true);
    expect(r.ambiguous).toBeUndefined();
    expect(r.agents[0]?.agentId).toBe("a1");
  });
});
