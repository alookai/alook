import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { credentialFilePathByMachineId, daemonStatus } from "./daemonStart";

describe("daemonStart — credentialFilePath by machineId", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemon-test-"));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("derives path from machineId, not from the CLI arg", () => {
    const machineId = "cm_abc123";
    const p1 = credentialFilePathByMachineId(baseDir, machineId);
    const p2 = credentialFilePathByMachineId(baseDir, machineId);
    expect(p1).toBe(p2);
    expect(p1).toContain(`${machineId}.credential.json`);
  });

  it("same machineId produces the same path across two rotates — no orphaned files", () => {
    const machineId = "cm_abc123";
    const p = credentialFilePathByMachineId(baseDir, machineId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ credential: "cmk_first", machineId }), { mode: 0o600 });
    fs.writeFileSync(p, JSON.stringify({ credential: "cmk_second", machineId }), { mode: 0o600 });
    const files = fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith(".credential.json"));
    expect(files).toEqual([`${machineId}.credential.json`]);
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed).toEqual({ credential: "cmk_second", machineId });
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
  const ID = "d0d0d0d0d0d0";
  const daemonSubdir = () => path.join(baseDir, "daemons", ID);
  const writeSnap = (writtenAt: number) => {
    const dir = daemonSubdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        writtenAt,
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
    writeSnap(1000);
    const r = daemonStatus({ id: ID, baseDir, now: () => 3000 }); // 2s old
    expect(r.found).toBe(true);
    expect(r.freshness).toBe("fresh");
    expect(r.ageMs).toBe(2000);
    expect(r.agents[0]?.agentId).toBe("a1");
    expect(r.agents[0]?.derivedActivity).toBe("idle");
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
});
