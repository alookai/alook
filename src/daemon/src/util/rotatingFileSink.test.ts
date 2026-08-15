import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
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
    const line = "x".repeat(499);
    for (let i = 0; i < 20; i++) sink.write(line);

    const active = existsSync(path) ? statSync(path).size : 0;
    const rotated = existsSync(`${path}.1`) ? statSync(`${path}.1`).size : 0;
    // Total bounded by ~2×maxBytes + one line's slack (a write can push the
    // active file slightly past maxBytes before the NEXT write rotates it).
    expect(active + rotated).toBeLessThanOrEqual(2 * maxBytes + line.length + 1);
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
    const rotatedPath = `${path}.1`;
    const sink = createRotatingFileSink(path, 20, { mode: 0o600 });
    sink.write("a".repeat(20));
    sink.write("latest");

    expect(readFileSync(path, "utf8")).toBe("latest\n");
    expect(readFileSync(rotatedPath, "utf8")).toBe(`${"a".repeat(20)}\n`);
    expectSecureMode(path, 0o600);
    // Rotated `.1` keeps the prior active's mode on POSIX; Windows mode bits
    // are not meaningful after rename, so only assert the active path there.
    if (process.platform !== "win32") {
      expectSecureMode(rotatedPath, 0o600);
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

  it("secures pre-existing broad active and rotated generations before appending", () => {
    const path = join(dir, "daemon.log");
    const rotatedPath = `${path}.1`;
    writeFileSync(path, "active-old\n");
    writeFileSync(rotatedPath, "rotated-old\n");
    chmodSync(path, 0o644);
    chmodSync(rotatedPath, 0o644);
    vi.mocked(chmodSync).mockClear();
    const sink = createRotatingFileSink(path, 100, { mode: 0o600, hardMaxBytes: true });

    sink.write("new");

    expectSecureMode(path, 0o600);
    expectSecureMode(rotatedPath, 0o600);
    expect(readFileSync(path, "utf8")).toBe("active-old\nnew\n");
    expect(readFileSync(rotatedPath, "utf8")).toBe("rotated-old\n");
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

  it("fails closed when a pre-existing rotated generation cannot be secured", () => {
    const path = join(dir, "daemon.log");
    const rotatedPath = `${path}.1`;
    writeFileSync(path, "active\n");
    writeFileSync(rotatedPath, "rotated\n");
    const failures: Array<{ operation: string; error: unknown }> = [];
    vi.mocked(chmodSync).mockImplementationOnce(() => {
      throw new Error("rotated chmod failed");
    });
    const sink = createRotatingFileSink(path, 100, {
      mode: 0o600,
      hardMaxBytes: true,
      onError: (info) => failures.push(info),
    });

    sink.write("secret");

    expect(readFileSync(path, "utf8")).toBe("active\n");
    expect(readFileSync(rotatedPath, "utf8")).toBe("rotated\n");
    expect(failures.map(({ operation }) => operation)).toEqual(["chmod"]);
  });

  it("omits a snapshot generation that cannot be secured", () => {
    const path = join(dir, "daemon.log");
    const rotatedPath = `${path}.1`;
    writeFileSync(path, "active\n");
    writeFileSync(rotatedPath, "rotated\n");
    const failures: Array<{ operation: string; error: unknown }> = [];
    vi.mocked(chmodSync).mockImplementationOnce(() => {
      throw new Error("rotated chmod failed");
    });
    const sink = createRotatingFileSink(path, 100, {
      mode: 0o600,
      onError: (info) => failures.push(info),
    });

    const snapshot = sink.openSnapshot();

    expect(snapshot.files.map((file) => file.path)).toEqual([path]);
    expect(failures.map(({ operation }) => operation)).toEqual(["chmod"]);
    snapshot.close();
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

  it("drops a hard-capped write when the rotated path is not a regular file", () => {
    const failures: Array<{ operation: string; error: unknown }> = [];
    const path = join(dir, "runtime-raw-events-a1.jsonl");
    const sink = createRotatingFileSink(path, 20, {
      hardMaxBytes: true,
      onError: (info) => failures.push(info),
    });
    sink.write("a".repeat(19));
    mkdirSync(`${path}.1`);

    expect(() => sink.write("secret")).not.toThrow();
    expect(failures.map(({ operation }) => operation)).toEqual(["unsafe_generation"]);
    expect(readFileSync(path, "utf8")).toBe(`${"a".repeat(19)}\n`);
    expect(statSync(path).size).toBeLessThanOrEqual(20);
  });

  it("drops a single record larger than the hard cap", () => {
    const failures: Array<{ operation: string }> = [];
    const path = join(dir, "daemon.log");
    const sink = createRotatingFileSink(path, 20, {
      hardMaxBytes: true,
      onError: (info) => failures.push(info),
    });
    sink.write("x".repeat(20));
    expect(existsSync(path)).toBe(false);
    expect(failures).toEqual([expect.objectContaining({ operation: "oversize" })]);
  });

  it("removes pre-existing generations above the hard cap during secure preflight", () => {
    const path = join(dir, "daemon.log");
    writeFileSync(path, "active is too large");
    writeFileSync(`${path}.1`, "rotated is too large");
    const failures: Array<{ operation: string }> = [];
    const sink = createRotatingFileSink(path, 8, {
      mode: 0o600,
      hardMaxBytes: true,
      onError: (info) => failures.push(info),
    });

    expect(sink.secure()).toBe(true);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(failures.map(({ operation }) => operation)).toEqual([
      "oversize_generation",
      "oversize_generation",
    ]);
  });

  it("opens a stable rotated + active snapshot with pinned sizes", () => {
    const path = join(dir, "daemon.log");
    const sink = createRotatingFileSink(path, 8, { hardMaxBytes: true, mode: 0o600 });
    sink.write("old");
    sink.write("newer");
    const snapshot = sink.openSnapshot();
    sink.write("tail");
    expect(snapshot.files.map((file) => file.path)).toEqual([`${path}.1`, path]);
    const contents = snapshot.files.map((file) => {
      const buffer = Buffer.alloc(file.size);
      readSync(file.fd, buffer, 0, file.size, 0);
      return buffer.toString("utf8");
    });
    expect(contents).toEqual(["old\n", "newer\n"]);
    snapshot.close();
    expect(() => snapshot.close()).not.toThrow();
  });
});
