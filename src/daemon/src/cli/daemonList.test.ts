import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { daemonList } from "./daemonStart";
import { renderDaemonList } from "./index";

/*
 * C3 (plans/daemon-cli-humanize-charter.md): `daemon list` returns an addressing
 * `id` (= pidfile name, what `daemon stop <id>` eats) + agents/lastActive from
 * status.json + pid/alive — and NO machine-key/credential. The renderer prints a
 * human table, not JSON, with the machine key nowhere in sight (red line 2).
 */

describe("daemonList — C3 fields", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-daemonlist-"));
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns id (subdir name) + pid + alive, and NEVER the machine key", () => {
    // Per-key subdir (C0): daemons/<id>/daemon.pid.
    const dir = path.join(baseDir, "daemons", "abc123def456");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: "cmk_super_secret_key" }));

    const list = daemonList({ baseDir });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("abc123def456"); // the subdir name = the stop id
    expect(list[0]!.pid).toBe(process.pid);
    expect(list[0]!.alive).toBe(true);
    // The credential must not appear anywhere in the returned shape.
    expect(JSON.stringify(list[0])).not.toContain("cmk_super_secret_key");
    expect(JSON.stringify(list[0])).not.toContain("secret");
  });

  it("prunes a dead daemon's pidfile and reports nothing alive for it", () => {
    const dir = path.join(baseDir, "daemons", "dead00000000");
    fs.mkdirSync(dir, { recursive: true });
    // pid 1 is init — process.kill(1, 0) from a normal user throws EPERM, which
    // isProcessAlive treats as... alive. Use a pid that's almost certainly dead.
    const deadPid = 2 ** 22; // very unlikely to be a live pid
    const pidfile = path.join(dir, "daemon.pid");
    fs.writeFileSync(pidfile, JSON.stringify({ pid: deadPid, key: "cmk_x" }));

    const list = daemonList({ baseDir });
    const dead = list.find((d) => d.id === "dead00000000");
    if (dead) {
      expect(dead.alive).toBe(false);
      expect(dead.agents).toBeNull(); // no live agents attributed to a dead daemon
    }
    // pidfile pruned on read
    expect(fs.existsSync(pidfile)).toBe(false);
  });

  it("empty when no daemons dir", () => {
    expect(daemonList({ baseDir })).toEqual([]);
  });
});

describe("renderDaemonList — human table (C2)", () => {
  const NOW = 1_000_000_000_000;

  it("prints a table with the ID column and no machine key", () => {
    const out = renderDaemonList(
      [{ id: "0ad8e360b064", pid: 39967, alive: true, agents: 8, running: 2, lastActiveMs: NOW - 12_000 }],
      NOW,
    );
    expect(out).toContain("ID");
    expect(out).toContain("0ad8e360b064");
    expect(out).toContain("39967"); // pid
    expect(out).toContain("running");
    expect(out).toContain("just now (12s)");
    expect(out).not.toContain("cmk_");
    expect(out).not.toContain("cmt_");
  });

  it("AGENTS column shows running/total, not just total (C2 imprecision fix)", () => {
    const out = renderDaemonList(
      [{ id: "d1", pid: 1, alive: true, agents: 8, running: 2, lastActiveMs: NOW }],
      NOW,
    );
    // "2/8" = 2 working of 8 registered — the fix for AGENTS overstating activity.
    expect(out).toContain("2/8");
  });

  it("empty state is human, not JSON", () => {
    const out = renderDaemonList([], NOW);
    expect(out).toBe("No daemons running on this machine.");
  });

  it("per-daemon data → NO multi-daemon caveat footnote (C0 made each row its own)", () => {
    const two = renderDaemonList(
      [
        { id: "a", pid: 1, alive: true, agents: 3, running: 3, lastActiveMs: NOW },
        { id: "b", pid: 2, alive: true, agents: 7, running: 1, lastActiveMs: NOW },
      ],
      NOW,
    );
    // Each row is its own daemon's snapshot now — no "last writer" caveat.
    expect(two).not.toContain("last writer");
    expect(two).toContain("3/3");
    expect(two).toContain("1/7"); // distinct per row, not a shared count
  });

  it("renders — for missing agents (dead or no snapshot)", () => {
    const out = renderDaemonList([{ id: "x", pid: 5, alive: false, agents: null, running: null, lastActiveMs: null }], NOW);
    expect(out).toContain("○ dead");
    expect(out).toContain("—");
  });
});

describe("daemonList — C0 per-daemon subdir layout + multi-daemon isolation", () => {
  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-c0-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  // `running` defaults to all agents; pass fewer to mix in idle agents.
  const writeDaemon = (
    id: string,
    pid: number,
    agents: number,
    writtenAt: number,
    running = agents,
    sinceProgressMs = 1,
  ) => {
    const dir = path.join(baseDir, "daemons", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid, key: `cmk_${id}` }));
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        writtenAt,
        agents: Array.from({ length: agents }, (_, i) => ({
          agentId: `${id}-a${i}`,
          status: "running",
          derivedActivity: i < running ? "running" : "idle",
          turnActive: i < running, inbox: 0, sinceProgressMs, stoppingSince: null,
        })),
      }),
    );
  };

  it("discovers a subdir daemon and reads ITS OWN status (id = subdir name)", () => {
    writeDaemon("111111111111", process.pid, 3, Date.now());
    const list = daemonList({ baseDir });
    const row = list.find((d) => d.id === "111111111111");
    expect(row).toBeTruthy();
    expect(row!.alive).toBe(true);
    expect(row!.agents).toBe(3); // this daemon's own count, from its own status.json
  });

  it("running counts only derivedActivity==='running', not total (C2)", () => {
    // 6 agents, but only 4 actually working (2 idle) — the AGENTS-imprecision case.
    writeDaemon("222222222222", process.pid, 6, Date.now(), 4);
    const row = daemonList({ baseDir }).find((d) => d.id === "222222222222");
    expect(row!.agents).toBe(6); // total registered
    expect(row!.running).toBe(4); // only the working ones → renders "4/6"
  });

  it("TWO daemons each show their OWN agent count — not the last writer's (the multi-daemon bug fix)", () => {
    // The pre-C0 bug: a single global status.json meant both rows showed the
    // last writer's count. Per-key subdir status → each row is its own.
    writeDaemon("aaaaaaaaaaaa", process.pid, 3, Date.now());
    writeDaemon("bbbbbbbbbbbb", process.pid, 7, Date.now());
    const list = daemonList({ baseDir });
    const a = list.find((d) => d.id === "aaaaaaaaaaaa");
    const b = list.find((d) => d.id === "bbbbbbbbbbbb");
    expect(a!.agents).toBe(3);
    expect(b!.agents).toBe(7); // distinct — NOT both showing one value
  });

  it("derives distinct LAST ACTIVE values from each daemon's latest agent progress", () => {
    const writtenAtA = 1_000_000;
    const writtenAtB = writtenAtA + 24;
    writeDaemon("cm_active_a", process.pid, 1, writtenAtA, 0, 700);
    writeDaemon("cm_active_b", process.pid, 1, writtenAtB, 0, 12_000);

    const list = daemonList({ baseDir });
    expect(list.find((row) => row.id === "cm_active_a")?.lastActiveMs).toBe(999_300);
    expect(list.find((row) => row.id === "cm_active_b")?.lastActiveMs).toBe(988_024);

    const output = renderDaemonList(list, writtenAtB);
    expect(output.split("\n").find((line) => line.includes("cm_active_a"))).toContain("just now (1s)");
    expect(output.split("\n").find((line) => line.includes("cm_active_b"))).toContain("just now (12s)");
  });

  it("shows no last activity when a daemon has no agents", () => {
    writeDaemon("cm_zeroagents", process.pid, 0, 1_000_000);
    const row = daemonList({ baseDir }).find((item) => item.id === "cm_zeroagents");

    expect(row?.lastActiveMs).toBeNull();
    expect(renderDaemonList([row!], 1_000_000).split(/\s{2,}/)).toContain("—");
  });

  it("treats invalid progress ages and the never-active epoch sentinel as no activity", () => {
    const id = "cm_badprogress";
    const dir = path.join(baseDir, "daemons", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: `cmk_${id}` }));
    fs.writeFileSync(
      path.join(dir, "status.json"),
      `{"writtenAt":1000,"agents":[{"sinceProgressMs":1e400},{"sinceProgressMs":-1},{"sinceProgressMs":1200}]}`,
    );

    expect(daemonList({ baseDir }).find((row) => row.id === id)?.lastActiveMs).toBeNull();
  });

  it("uses the latest valid progress age when invalid and sentinel agents are mixed in", () => {
    const id = "cm_mixedprogress";
    const dir = path.join(baseDir, "daemons", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: `cmk_${id}` }));
    fs.writeFileSync(
      path.join(dir, "status.json"),
      `{"writtenAt":1000,"agents":[{"sinceProgressMs":1e400},{"sinceProgressMs":1000},{"sinceProgressMs":300},{"sinceProgressMs":100}]}`,
    );

    expect(daemonList({ baseDir }).find((row) => row.id === id)?.lastActiveMs).toBe(900);
  });

  it("ignores future activity candidates instead of rendering them as just now", () => {
    const id = "cm_futureonly";
    const dir = path.join(baseDir, "daemons", id);
    const writtenAt = Date.now() + 100_000;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: `cmk_${id}` }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      writtenAt,
      agents: [{ sinceProgressMs: 1 }],
    }));

    const row = daemonList({ baseDir }).find((item) => item.id === id);
    expect(row?.lastActiveMs).toBeNull();
    expect(renderDaemonList([row!])).toContain("—");
  });

  it("ignores a future candidate while retaining the latest valid activity", () => {
    const id = "cm_futuremixed";
    const dir = path.join(baseDir, "daemons", id);
    const validProgressAt = Date.now() - 500;
    const writtenAt = validProgressAt + 100_000;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: `cmk_${id}` }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      writtenAt,
      agents: [
        { sinceProgressMs: 1 },
        { sinceProgressMs: writtenAt - validProgressAt },
      ],
    }));

    expect(daemonList({ baseDir }).find((row) => row.id === id)?.lastActiveMs).toBe(validProgressAt);
  });

  it("only subdir daemons are listed — a stray flat file is NOT discovered (legacy compat dropped, Gus #466)", () => {
    // No migration compat: a bare `<id>.pid` file (pre-C0 shape) is ignored;
    // only per-key subdirs are daemons. Keeps discovery single-path, no legacy
    // debt. (Cutover: old flat residue must be cleaned manually before restart.)
    const dir = path.join(baseDir, "daemons");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "straystray00.pid"), JSON.stringify({ pid: process.pid, key: "cmk_stray" }));
    writeDaemon("eeeeeeeeeeee", process.pid, 2, Date.now());

    const list = daemonList({ baseDir });
    expect(list.find((d) => d.id === "straystray00")).toBeUndefined(); // flat file ignored
    expect(list.find((d) => d.id === "eeeeeeeeeeee")?.agents).toBe(2); // only subdir daemons
  });

  it("ignores directories whose names are neither current nor legacy daemon ids", () => {
    writeDaemon("not-a-daemon-id", process.pid, 2, Date.now());
    writeDaemon("abcdefabcdef", process.pid, 1, Date.now());

    const list = daemonList({ baseDir });
    expect(list.map((row) => row.id)).toEqual(["abcdefabcdef"]);
  });
});

describe("daemonList — C0.1 machineId anchor (cmt_ rotation doesn't drift)", () => {
  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-c01-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  // Simulate a daemon whose dir is anchored on machineId; the pidfile's `key`
  // breadcrumb is whatever token that generation dialed with (a one-time cmt_).
  const writeGeneration = (machineId: string, cmtKey: string) => {
    const dir = path.join(baseDir, "daemons", machineId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid: process.pid, key: cmtKey }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      writtenAt: Date.now(),
      agents: [{ agentId: "a", status: "running", derivedActivity: "running", turnActive: true, inbox: 0, sinceProgressMs: 1, stoppingSince: null }],
    }));
  };

  it("two reconnect generations (different cmt_, same machineId) → ONE dir, ONE row (the C0.1 regression)", () => {
    const MACHINE_ID = "cm_machine_stable01";
    // First pairing: cmt_ token A.
    writeGeneration(MACHINE_ID, "cmt_tokenAAAA");
    // Reconnect mints a fresh cmt_ (token B) bound to the SAME machineId — the
    // dir is keyed on machineId, so it's the SAME dir, not a new one. Pre-C0.1
    // this drifted to a second keyHash(cmt_) subdir + orphaned the first.
    writeGeneration(MACHINE_ID, "cmt_tokenBBBB");

    const list = daemonList({ baseDir });
    const rows = list.filter((d) => d.id === MACHINE_ID);
    expect(rows).toHaveLength(1); // no drift: still one daemon dir
    // Only one subdir exists on disk (not two hash dirs).
    expect(fs.readdirSync(path.join(baseDir, "daemons")).filter((f) => f.startsWith("cm_"))).toEqual([MACHINE_ID]);
  });

  it("the list id IS the machineId (stable, long-term stop-able) — not a per-token hash", () => {
    writeGeneration("cm_machine_stable01", "cmt_whatever");
    const row = daemonList({ baseDir }).find((d) => d.id === "cm_machine_stable01");
    expect(row).toBeTruthy();
    expect(row!.id).toBe("cm_machine_stable01"); // the subdir name = machineId
    // A pidfile `key` breadcrumb (the volatile token) never leaks into the id/output.
    expect(JSON.stringify(row)).not.toContain("cmt_");
  });
});
