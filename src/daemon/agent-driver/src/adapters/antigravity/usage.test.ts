import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NativeUsageReader, nativeUsageHome, parseNativeGeneration, queryNativeRowsWithCli, queryNativeRows } from "./usage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function varint(value: bigint | number): number[] {
  let n = BigInt(value); const bytes: number[] = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return bytes;
}
const scalar = (field: number, value: bigint | number) => [...varint(field * 8), ...varint(value)];
const message = (field: number, value: number[]) => [...varint(field * 8 + 2), ...varint(value.length), ...value];
const generation = (usage: number[] = [...scalar(2, 90), ...scalar(3, 24), ...scalar(5, 23)]) => Buffer.from(message(1, [...message(4, usage), ...message(9, message(4, scalar(1, 1_791_091_200)))]));

describe("Antigravity native accounting", () => {
  it("uses native input/output once, without subtracting cache or adding thoughts again", () => {
    expect(parseNativeGeneration(generation([...scalar(2, 90), ...scalar(3, 24), ...scalar(5, 23), ...scalar(9, 7), ...scalar(10, 17)]))).toEqual({ usage: { input: 90, output: 24, cache: 23 }, occurredAt: "2026-10-04T05:20:00.000Z" });
  });
  it("preserves missing and empty usage as unknown, including absent cache", () => {
    expect(parseNativeGeneration(generation([])).usage).toEqual({ input: null, output: null, cache: null });
    expect(parseNativeGeneration(generation(scalar(2, 113))).usage).toEqual({ input: 113, output: null, cache: null });
    expect(parseNativeGeneration(generation(scalar(5, 0))).usage.cache).toBe(0);
    expect(parseNativeGeneration(Buffer.from(message(1, message(4, scalar(2, 2))))).occurredAt).toBeNull();
  });
  it.each([[0], [10, 99], [10, 2, 8], [15], [9, 0], [13, 0], [128], [...Array(11).fill(128)], [10, 255, 255, 255, 255, 255, 255, 255, 255, 127]])("rejects malformed record %j", (bytes) => {
    expect(() => parseNativeGeneration(Buffer.from(bytes))).toThrow();
  });
  it("rejects overflowing counts and bounds native payloads", () => {
    expect(() => parseNativeGeneration(generation(scalar(2, BigInt(Number.MAX_SAFE_INTEGER) + 1n)))).toThrow();
    expect(() => parseNativeGeneration(new Uint8Array(4 * 1024 * 1024 + 1))).toThrow();
  });
  it("deduplicates by session and generation, replays after restart, and leaves child totals unknown", async () => {
    const rows = [{ idx: 0, data: generation().toString("hex"), has_children: 0 }, { idx: 1, data: generation().toString("hex"), has_children: 1 }];
    const query = async (_: string, cursor: number) => rows.filter((row) => row.idx > cursor);
    const reader = new NativeUsageReader("/fixture", "native-session", query);
    const batch = await reader.read();
    expect(batch.complete).toBe(true);
    const first = batch.samples;
    expect(first[0]).toMatchObject({ usage: { input: 90, output: 24, cache: 23 }, identity: { source: expect.stringMatching(/^antigravity:[a-f0-9]{16}:native-session$/), index: 0 } });
    expect(first[1].usage).toEqual({ input: null, output: null, cache: null });
    expect(await reader.read()).toEqual({ samples: [], complete: true, incompleteScope: true });
    expect((await new NativeUsageReader("/fixture", "native-session", query).read()).samples).toEqual(first);
    expect(() => new NativeUsageReader("/fixture", "../other")).toThrow();
  });
  it("does not advance its cursor on partial failure or missing historical timestamps", async () => {
    const rows = [{ idx: 0, data: generation().toString("hex"), has_children: 0 }, { idx: 1, data: "ff", has_children: 0 }];
    const reader = new NativeUsageReader("/fixture", "native", async (_, cursor) => rows.filter((row) => row.idx > cursor));
    await expect(reader.read()).rejects.toThrow();
    rows.pop();
    expect((await reader.read()).samples).toHaveLength(1);
    await expect(new NativeUsageReader("/fixture", "native", async () => [{ idx: 0, data: "", has_children: 0 }]).read()).rejects.toThrow("timestamp");
  });
  it("resolves the actual transport home, including relative and tilde overrides", () => {
    expect(nativeUsageHome({ GEMINI_HOME: "private" }, "/work")).toBe("/work/private");
    expect(nativeUsageHome({ GEMINI_HOME: "~/private" }, "/work")).toMatch(/\/private$/);
    expect(nativeUsageHome({}, "/work")).toMatch(/\/\.gemini$/);
  });
  it("reads the live SQLite WAL view without modifying the provider database", async () => {
    const module = "node:sqlite";
    let sqlite: { DatabaseSync: new(path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void } };
    try { sqlite = await import(module); } catch { return; }
    const home = mkdtempSync(join(tmpdir(), "native-usage-")); roots.push(home);
    const directory = join(home, "antigravity-acp", "conversations"); mkdirSync(directory, { recursive: true });
    const db = new sqlite.DatabaseSync(join(directory, "native.db"));
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(has_subtrajectory INTEGER)");
      db.prepare("INSERT INTO gen_metadata VALUES(?,?)").run(0, generation());
      expect(await queryNativeRowsWithCli(join(directory, "native.db"), -1)).toMatchObject([{ idx: 0 }]);
      expect(await queryNativeRowsWithCli(join(directory, "native.db"), 0)).toEqual([]);
      const fallback = new NativeUsageReader(home, "native", (path, cursor) => queryNativeRows(path, cursor, async () => { throw new Error("Node 20 has no node:sqlite"); }));
      expect((await fallback.read()).samples).toMatchObject([{ usage: { input: 90, output: 24, cache: 23 } }]);
      expect(await fallback.read()).toEqual({ samples: [], complete: true });
      expect((await new NativeUsageReader(home, "native").read()).samples).toMatchObject([{ usage: { input: 90, output: 24, cache: 23 } }]);
    } finally { db.close(); }
  });
});

it("skips unrelated fixed-width protobuf fields and rejects invalid field zero", () => {
  const data = Buffer.concat([Buffer.from([17, ...Array(8).fill(0), 29, 0, 0, 0, 0]), generation()]);
  expect(parseNativeGeneration(data).usage.input).toBe(90);
  expect(() => parseNativeGeneration(Buffer.from([0, 0]))).toThrow();
});

it("reports incomplete bounded scans and drains seventeen batches without losing generation identity", async () => {
  const reader = new NativeUsageReader("/fixture", "native", async (_, cursor) => cursor >= 16 ? [] : [{ idx: cursor + 1, data: generation().toString("hex"), has_children: 0 }]);
  const first = await reader.read();
  expect(first.complete).toBe(false); expect(first.samples).toHaveLength(16);
  const second = await reader.read();
  expect(second.complete).toBe(true); expect(second.samples[0].identity.index).toBe(16);
});

it("bounds overlong varints and unsupported wire groups", () => {
  expect(() => parseNativeGeneration(Buffer.from(Array(10).fill(128)))).toThrow("varint");
  expect(() => parseNativeGeneration(Buffer.from([11]))).toThrow("Unsupported");
});
