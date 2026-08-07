import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingFileSink } from "./rotatingFileSink";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

/**
 * Windows cannot express POSIX 0600 via Node's mode bits (stat typically
 * reports 0666 after chmod). On win32, prove we invoked chmodSync with the
 * requested mode; on POSIX, assert the on-disk mode stuck.
 */
function expectSecureMode(path: string, mode: number): void {
  if (process.platform === "win32") {
    expect(vi.mocked(chmodSync)).toHaveBeenCalledWith(path, mode);
    return;
  }
  expect(statSync(path).mode & 0o777).toBe(mode);
}

describe("createRotatingFileSink (batch E1 — bounded default trace backing)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fsm-sink-"));
    vi.mocked(chmodSync).mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps total on-disk bytes across many writes (~2×maxBytes, active + one rotated)", () => {
    const path = join(dir, "trace.jsonl");
    const maxBytes = 1000;
    const sink = createRotatingFileSink(path, maxBytes);
    // Write far more than the cap: 500 lines × ~100 bytes = ~50KB, cap is 1KB.
    const line = "x".repeat(99); // ~100 bytes with newline
    for (let i = 0; i < 500; i++) sink.write(line);

    const active = existsSync(path) ? statSync(path).size : 0;
    const rotated = existsSync(`${path}.1`) ? statSync(`${path}.1`).size : 0;
    // Total bounded by ~2×maxBytes + one line's slack (a write can push the
    // active file slightly past maxBytes before the NEXT write rotates it).
    expect(active + rotated).toBeLessThanOrEqual(2 * maxBytes + 200);
    // And it kept SOMETHING (didn't just delete everything).
    expect(active + rotated).toBeGreaterThan(0);
  });

  it("retains the most-recent lines after rotation (last wedge stays readable)", () => {
    const path = join(dir, "trace.jsonl");
    const sink = createRotatingFileSink(path, 500);
    for (let i = 0; i < 200; i++) sink.write(`line-${i}`);
    // The active file's last line should be the most recent write.
    const activeContent = readFileSync(path, "utf8").trim().split("\n");
    expect(activeContent[activeContent.length - 1]).toBe("line-199");
  });

  it("maxBytes <= 0 disables rotation (unbounded single file)", () => {
    const path = join(dir, "trace.jsonl");
    const sink = createRotatingFileSink(path, 0);
    for (let i = 0; i < 200; i++) sink.write("x".repeat(99));
    expect(existsSync(`${path}.1`)).toBe(false); // never rotated
    expect(statSync(path).size).toBeGreaterThan(10_000); // all of it in one file
  });

  it("never throws when the target directory does not exist (best-effort)", () => {
    const sink = createRotatingFileSink(join(dir, "nope", "trace.jsonl"), 1000);
    expect(() => sink.write("line")).not.toThrow();
  });

  it("keeps secure mode on both active and rotated generations", () => {
    const path = join(dir, "runtime-raw-events-a1.jsonl");
    const sink = createRotatingFileSink(path, 20, { mode: 0o600 });
    sink.write("a".repeat(20));
    sink.write("latest");

    expectSecureMode(path, 0o600);
    // Rotated `.1` keeps the prior active's mode on POSIX; Windows mode bits
    // are not meaningful after rename, so only assert the active path there.
    if (process.platform !== "win32") {
      expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    }
  });

  it("secures a pre-existing broad active file before appending", () => {
    const path = join(dir, "runtime-raw-events-a1.jsonl");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o644);
    vi.mocked(chmodSync).mockClear();
    const sink = createRotatingFileSink(path, 100, { mode: 0o600 });

    sink.write("new");

    expectSecureMode(path, 0o600);
    expect(readFileSync(path, "utf8")).toBe("old\nnew\n");
  });

  it("drops a secure-mode write when chmod fails", () => {
    const path = join(dir, "runtime-raw-events-a1.jsonl");
    writeFileSync(path, "old\n");
    const failures: Array<{ operation: string; error: unknown }> = [];
    vi.mocked(chmodSync).mockImplementationOnce(() => {
      throw new Error("chmod failed");
    });
    const sink = createRotatingFileSink(path, 100, {
      mode: 0o600,
      onError: (info) => failures.push(info),
    });

    sink.write("secret");

    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(failures.map(({ operation }) => operation)).toEqual(["chmod"]);
  });

  it("reports a write failure without throwing", () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const sink = createRotatingFileSink(join(dir, "nope", "trace.jsonl"), 1000, {
      mode: 0o600,
      onError: (info) => failures.push(info),
    });

    expect(() => sink.write("line")).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.operation).toBe("append");
  });

  it("reports a rotation failure and continues writing", () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const path = join(dir, "trace.jsonl");
    const sink = createRotatingFileSink(path, 20, {
      onError: (info) => failures.push(info),
    });
    sink.write("a".repeat(20));
    mkdirSync(`${path}.1`);

    expect(() => sink.write("latest")).not.toThrow();
    expect(failures.some(({ operation }) => operation === "rotate")).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("latest\n");
  });

  it("drops a hard-capped write when its required rotation fails", () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const path = join(dir, "runtime-raw-events-a1.jsonl");
    const sink = createRotatingFileSink(path, 20, {
      hardMaxBytes: true,
      onError: (info) => failures.push(info),
    });
    sink.write("a".repeat(19));
    mkdirSync(`${path}.1`);

    expect(() => sink.write("secret")).not.toThrow();
    expect(failures.map(({ operation }) => operation)).toEqual(["rotate"]);
    expect(readFileSync(path, "utf8")).toBe(`${"a".repeat(19)}\n`);
    expect(statSync(path).size).toBeLessThanOrEqual(20);
  });
});
