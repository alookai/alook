import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStatusFile, type DaemonStatusSnapshot } from "./statusFile";

describe("writeStatusFile (batch E2 — atomic daemon status snapshot)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "status-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const snap: DaemonStatusSnapshot = {
    writtenAt: 1000,
    agents: [
      { agentId: "a1", status: "running", derivedActivity: "idle", turnActive: false, inbox: 0, sinceProgressMs: 42, stoppingSince: null },
    ],
  };

  it("writes valid JSON that round-trips", () => {
    const path = join(dir, "status.json");
    writeStatusFile(path, snap);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snap);
  });

  it("leaves no .tmp behind (rename completed)", () => {
    const path = join(dir, "status.json");
    writeStatusFile(path, snap);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("never throws when the target dir does not exist (best-effort)", () => {
    expect(() => writeStatusFile(join(dir, "nope", "status.json"), snap)).not.toThrow();
  });
});
