import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { SESSION_STOP_GRACE_MS } from "../agent-driver/src/internal/killTree.js";

/**
 * Structural pins for extracted constants. We assert *magnitudes*, not
 * literal spellings — a rename is fine, a value drift is not (the drivers
 * across the daemon lean on these being stable).
 *
 * Constants that are exported are pinned by import. Constants that are file-
 * local get checked via a lightweight source grep so a copy-paste drift
 * (someone bumps `PROBE_TIMEOUT_MS = 5000` to 10000 without updating the
 * "why so short" comment or its tests) is loud in CI.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(HERE, rel), "utf-8");
}

describe("magic-number extractions", () => {
  it("SESSION_STOP_GRACE_MS === 2000 (unified across manager + session stop)", () => {
    expect(SESSION_STOP_GRACE_MS).toBe(2000);
  });

  it("SESSION_STOP_GRACE_MS stays strictly below the daemon's own STOP_GRACE_MS", () => {
    // `daemonStop` SIGKILLs the daemon after STOP_GRACE_MS; the daemon's
    // SIGTERM handler awaits per-session kills that each wait
    // SESSION_STOP_GRACE_MS. Equal windows orphan detached agent processes.
    const daemonStartSrc = readSrc("cli/daemonStart.ts");
    const match = daemonStartSrc.match(/const STOP_GRACE_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(SESSION_STOP_GRACE_MS).toBeLessThan(Number(match![1]));
  });

  it("ERROR_EXCERPT_MAX_BYTES is set to 4000 in runtime/errorDiagnostics.ts", () => {
    expect(readSrc("runtime/errorDiagnostics.ts")).toMatch(/ERROR_EXCERPT_MAX_BYTES\s*=\s*4000\b/);
  });

  it("ERROR_FINGERPRINT_LEN is set to 16 in runtime/errorDiagnostics.ts", () => {
    expect(readSrc("runtime/errorDiagnostics.ts")).toMatch(/ERROR_FINGERPRINT_LEN\s*=\s*16\b/);
  });

  it("DEFAULT_PING_INTERVAL_MS is set to 15_000 in server/wsControlChannel.ts", () => {
    expect(readSrc("server/wsControlChannel.ts")).toMatch(/DEFAULT_PING_INTERVAL_MS\s*=\s*15_?000\b/);
  });

  it("DEFAULT_PONG_TIMEOUT_MS is set to 30_000 in server/wsControlChannel.ts", () => {
    expect(readSrc("server/wsControlChannel.ts")).toMatch(/DEFAULT_PONG_TIMEOUT_MS\s*=\s*30_?000\b/);
  });

  it("MESSAGE_ID_SHORT_LEN is set to 8 in inbox/projection.ts", () => {
    expect(readSrc("inbox/projection.ts")).toMatch(/MESSAGE_ID_SHORT_LEN\s*=\s*8\b/);
  });

});
