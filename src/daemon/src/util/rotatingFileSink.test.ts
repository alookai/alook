import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingFileSink } from "./rotatingFileSink";

describe("createRotatingFileSink (batch E1 — bounded default trace backing)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fsm-sink-"));
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
});
