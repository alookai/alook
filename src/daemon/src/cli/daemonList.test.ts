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

  it("returns id (pidfile name) + pid + alive, and NEVER the machine key", () => {
    const daemonsDir = path.join(baseDir, "daemons");
    fs.mkdirSync(daemonsDir, { recursive: true });
    // A live daemon: use our own pid (definitely alive).
    fs.writeFileSync(path.join(daemonsDir, "abc123def456.pid"), JSON.stringify({ pid: process.pid, key: "cmk_super_secret_key" }));

    const list = daemonList({ baseDir });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("abc123def456"); // the pidfile name = the stop id
    expect(list[0]!.pid).toBe(process.pid);
    expect(list[0]!.alive).toBe(true);
    // The credential must not appear anywhere in the returned shape.
    expect(JSON.stringify(list[0])).not.toContain("cmk_super_secret_key");
    expect(JSON.stringify(list[0])).not.toContain("secret");
  });

  it("prunes a dead pidfile and reports nothing alive for it", () => {
    const daemonsDir = path.join(baseDir, "daemons");
    fs.mkdirSync(daemonsDir, { recursive: true });
    // pid 1 is init — process.kill(1, 0) from a normal user throws EPERM, which
    // isProcessAlive treats as... alive. Use a pid that's almost certainly dead.
    const deadPid = 2 ** 22; // very unlikely to be a live pid
    fs.writeFileSync(path.join(daemonsDir, "deadone00000.pid"), JSON.stringify({ pid: deadPid, key: "cmk_x" }));

    const list = daemonList({ baseDir });
    const dead = list.find((d) => d.id === "deadone00000");
    if (dead) {
      expect(dead.alive).toBe(false);
      expect(dead.agents).toBeNull(); // no live agents attributed to a dead daemon
    }
    // pidfile pruned on read
    expect(fs.existsSync(path.join(daemonsDir, "deadone00000.pid"))).toBe(false);
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
