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
    const dir = path.join(baseDir, "daemons", "deadone00000");
    fs.mkdirSync(dir, { recursive: true });
    // pid 1 is init — process.kill(1, 0) from a normal user throws EPERM, which
    // isProcessAlive treats as... alive. Use a pid that's almost certainly dead.
    const deadPid = 2 ** 22; // very unlikely to be a live pid
    const pidfile = path.join(dir, "daemon.pid");
    fs.writeFileSync(pidfile, JSON.stringify({ pid: deadPid, key: "cmk_x" }));

    const list = daemonList({ baseDir });
    const dead = list.find((d) => d.id === "deadone00000");
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
      [{ id: "0ad8e360b064", pid: 39967, alive: true, agents: 8, lastActiveMs: NOW - 12_000 }],
      NOW,
    );
    expect(out).toContain("ID");
    expect(out).toContain("0ad8e360b064");
    expect(out).toContain("8"); // agents
    expect(out).toContain("39967"); // pid
    expect(out).toContain("running");
    expect(out).toContain("just now (12s)");
    expect(out).not.toContain("cmk_");
    expect(out).not.toContain("cmt_");
  });

  it("empty state is human, not JSON", () => {
    const out = renderDaemonList([], NOW);
    expect(out).toBe("No daemons running on this machine.");
  });

  it("footnotes the global-status caveat only with >1 daemon (red line 5)", () => {
    const one = renderDaemonList([{ id: "a", pid: 1, alive: true, agents: 3, lastActiveMs: NOW }], NOW);
    expect(one).not.toContain("last writer");
    const two = renderDaemonList(
      [
        { id: "a", pid: 1, alive: true, agents: 3, lastActiveMs: NOW },
        { id: "b", pid: 2, alive: true, agents: 3, lastActiveMs: NOW },
      ],
      NOW,
    );
    expect(two).toContain("last writer");
  });

  it("renders — for missing agents/lastActive (dead or no snapshot)", () => {
    const out = renderDaemonList([{ id: "x", pid: 5, alive: false, agents: null, lastActiveMs: null }], NOW);
    expect(out).toContain("○ dead");
    expect(out).toContain("—");
  });
});

describe("daemonList — C0 per-daemon subdir layout + multi-daemon isolation", () => {
  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-c0-")); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  const writeDaemon = (id: string, pid: number, agents: number, writtenAt: number) => {
    const dir = path.join(baseDir, "daemons", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "daemon.pid"), JSON.stringify({ pid, key: `cmk_${id}` }));
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({
        writtenAt,
        agents: Array.from({ length: agents }, (_, i) => ({
          agentId: `${id}-a${i}`, status: "running", derivedActivity: "running", turnActive: true, inbox: 0, sinceProgressMs: 1, stoppingSince: null,
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

  it("only subdir daemons are listed — a stray flat file is NOT discovered (legacy compat dropped, Gus #466)", () => {
    // No migration compat: a bare `<id>.pid` file (pre-C0 shape) is ignored;
    // only per-key subdirs are daemons. Keeps discovery single-path, no legacy
    // debt. (Cutover: old flat residue must be cleaned manually before restart.)
    const dir = path.join(baseDir, "daemons");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "straystray00.pid"), JSON.stringify({ pid: process.pid, key: "cmk_stray" }));
    writeDaemon("newnewnewnew", process.pid, 2, Date.now());

    const list = daemonList({ baseDir });
    expect(list.find((d) => d.id === "straystray00")).toBeUndefined(); // flat file ignored
    expect(list.find((d) => d.id === "newnewnewnew")?.agents).toBe(2); // only subdir daemons
  });
});
