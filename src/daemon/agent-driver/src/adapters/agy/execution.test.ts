import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyStateHome,
  isAgyVersionAtLeast,
  NativeExecutionReader,
  NativeSessionActivityReader,
  openNativeExecutionDatabase,
  parseAgyVersion,
  parseNativeExecution,
  queryExecutionRows,
  resolveAgyUsageProfile,
} from "./execution.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const payload = (reason: number, id: string, error?: string) => Buffer.concat([
  Buffer.from([8, reason, 74, Buffer.byteLength(id)]), Buffer.from(id),
  ...(error ? [Buffer.from([98, Buffer.byteLength(error)]), Buffer.from(error)] : []),
]);
const row = (idx: number, reason: number, id: string, error?: string) => ({ idx, has_children: 0, data: payload(reason, id, error).toString("hex") });

describe("agy persisted execution outcome", () => {
  it("keeps failed history out of later successful and resumed roots", async () => {
    let rows: ReturnType<typeof row>[] = [];
    const read = async (_path: string, after?: number) => after === undefined ? rows.slice(-1) : rows.filter(value => value.idx > after);
    const reader = new NativeExecutionReader("/isolated", "native", read);
    const first = await reader.checkpoint();
    rows.push(row(0, 1, "failure", "private provider failure"));
    expect(await reader.terminal(first)).toBe("failed");
    const second = await reader.checkpoint();
    rows.push(row(1, 4, "recovered"));
    expect(await reader.terminal(second)).toBe("success");
    const resumed = new NativeExecutionReader("/isolated", "native", read);
    const third = await resumed.checkpoint();
    rows.push(row(2, 1, "resume-failure", "private provider failure"));
    expect(await resumed.terminal(third)).toBe("failed");
    const fourth = await resumed.checkpoint();
    rows.push(row(3, 4, "resume-recovered"));
    expect(await resumed.terminal(fourth)).toBe("success");
    rows = [];
    await expect(resumed.terminal(fourth)).rejects.toThrow("unavailable");
  });

  it.each([[], [row(0, 4, "one"), row(1, 4, "two")], [row(2, 4, "gap")], [row(0, 4, "old")]].map(rows => ({ rows })))("rejects missing, multiple, skipped or reused execution identities", async ({ rows }) => {
    const reader = new NativeExecutionReader("/isolated", "native", async () => rows);
    await expect(reader.terminal({ index: -1, executionId: "old", lastStepIndex: -1 })).rejects.toThrow();
  });

  it("verifies a bounded contiguous continuation cohort only when enabled", async () => {
    const continued = (index: number, reason = 4, id = `execution-${index}`, step = index * 2 + 1) => ({
      idx: index, has_children: 0, data: Buffer.concat([payload(reason, id), Buffer.from([24, step])]).toString("hex"),
    });
    let rows = [continued(0), continued(1)];
    const reader = new NativeExecutionReader("/isolated", "native", async () => rows, true);
    const checkpoint = { index: -1, executionId: null, lastStepIndex: -1 };
    expect(await reader.terminal(checkpoint)).toBe("success");
    rows = [continued(0), continued(1, 1)];
    expect(await reader.terminal(checkpoint)).toBe("failed");
    for (const invalid of [
      [continued(0), continued(2)],
      [continued(0), continued(1, 4, "execution-0")],
      [continued(0), continued(1, 4, "second", 1)],
      Array.from({ length: 33 }, (_, index) => continued(index)),
    ]) {
      rows = invalid;
      await expect(reader.terminal(checkpoint)).rejects.toThrow();
    }
  });

  it.each([[1, "failed"], [2, "interrupted"], [3, "failed"], [4, "success"], [11, "failed"]] as const)("maps native reason %s without assistant-text or usage inference", async (reason, outcome) => {
    const reader = new NativeExecutionReader("/isolated", "native", async () => [row(0, reason, "new")]);
    expect(await reader.terminal({ index: -1, executionId: null, lastStepIndex: -1 })).toBe(outcome);
  });

  it("retains a native error even with an otherwise successful reason", async () => {
    const reader = new NativeExecutionReader("/isolated", "native", async () => [row(0, 4, "new", "private")]);
    expect(await reader.terminal({ index: -1, executionId: null, lastStepIndex: -1 })).toBe("failed");
  });

  it("rejects malformed records and traversal identities", () => {
    for (const data of [Buffer.from([8, 1, 74, 99]), payload(0, "new"), payload(12, "new"), payload(4, "../bad")]) expect(() => parseNativeExecution(data)).toThrow();
    expect(() => new NativeExecutionReader("/isolated", "../bad")).toThrow();
    const home = join(tmpdir(), "agy-isolated-home");
    const cwd = join(tmpdir(), "agy-isolated-cwd");
    expect(agyStateHome({ HOME: home, GEMINI_HOME: "~/custom" }, cwd)).toBe(join(home, "custom"));
    expect(agyStateHome({ HOME: home, GEMINI_HOME: "relative" }, cwd)).toBe(join(cwd, "relative"));
  });

  it.skipIf(Number(process.versions.node.split(".")[0]) < 22)("reads actual SQLite terminal records and fails closed when the database is unavailable", async () => {
    const module = "node:sqlite";
    const { DatabaseSync } = await import(module);
    const root = mkdtempSync(join(tmpdir(), "agy-execution-")); roots.push(root);
    const directory = join(root, "antigravity-cli", "conversations"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "native.db");
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,has_subtrajectory INTEGER)");
      const reader = new NativeExecutionReader(root, "native");
      const checkpoint = await reader.checkpoint();
      db.prepare("INSERT INTO executor_metadata(idx,data) VALUES(?,?)").run(0, payload(1, "actual", "native failure"));
      expect(await reader.terminal(checkpoint)).toBe("failed");
      expect(await queryExecutionRows(path, 0, -1, path => openNativeExecutionDatabase(path, async () => { throw new Error("Node20"); }))).toEqual([]);
      db.prepare("INSERT INTO steps(idx,has_subtrajectory) VALUES(?,?)").run(0, 1);
      await expect(reader.terminal(checkpoint)).rejects.toThrow("subtrajectory");
      expect((await queryExecutionRows(path)).map(value => ({ ...value, data: value.data.toLowerCase() }))).toEqual([row(0, 1, "actual", "native failure")]);
    } finally { db.close(); }
    await expect(new NativeExecutionReader(root, "missing").checkpoint()).rejects.toThrow();
    await expect(queryExecutionRows(path, -2)).rejects.toThrow();
  });
});


describe("agy native session activity", () => {
  it("uses only the indexed selected session and distinguishes busy, idle, missing and malformed states", async () => {
    const module = "node:sqlite";
    const { DatabaseSync } = await import(module);
    const root = mkdtempSync(join(tmpdir(), "agy-activity-")); roots.push(root);
    const directory = join(root, "antigravity-cli"); mkdirSync(directory);
    const db = new DatabaseSync(join(directory, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,status TEXT,not_fully_idle INTEGER)");
    db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?)").run("other", "CASCADE_RUN_STATUS_RUNNING", 1);
    const reader = new NativeSessionActivityReader(root, "selected", "1.5.16");
    try {
      expect(await reader.activity()).toBe("unknown");
      db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?)").run("selected", "CASCADE_RUN_STATUS_IDLE", 0);
      expect(await reader.activity()).toBe("idle");
      db.prepare("UPDATE conversation_summaries SET not_fully_idle=1 WHERE conversation_id=?").run("selected");
      expect(await reader.activity()).toBe("running");
      db.prepare("UPDATE conversation_summaries SET status=?,not_fully_idle=0 WHERE conversation_id=?").run("CASCADE_RUN_STATUS_RUNNING", "selected");
      expect(await reader.activity()).toBe("running");
      db.prepare("UPDATE conversation_summaries SET status=? WHERE conversation_id=?").run("UNRECOGNIZED", "selected");
      expect(await reader.activity()).toBe("unknown");
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT status,not_fully_idle FROM conversation_summaries WHERE conversation_id = ? LIMIT 1").all("selected");
      expect(JSON.stringify(plan)).toContain("SEARCH");
      expect(JSON.stringify(plan)).not.toContain("SCAN");
    } finally { db.close(); }
    expect(await new NativeSessionActivityReader(root, "selected", "1.5.18").activity()).toBe("unknown");
    expect(await new NativeSessionActivityReader(root, "selected", "1.5.15").activity()).toBe("unknown");
    expect(await new NativeSessionActivityReader(root, "selected", "2.0.0").activity()).toBe("unknown");
    expect(await new NativeSessionActivityReader(root, "selected", "future").activity()).toBe("unknown");
    expect(() => new NativeSessionActivityReader(root, "../other", "1.5.16")).toThrow();
  });

  it("evaluates semver bounds and resolves usage profiles across patch upgrades while rejecting major bumps", () => {
    expect(parseAgyVersion("1.5.18")).toEqual([1, 5, 18]);
    expect(parseAgyVersion("v1.5.18-beta.1")).toEqual([1, 5, 18]);
    expect(parseAgyVersion("future")).toBeNull();

    expect(isAgyVersionAtLeast("1.5.15", [1, 5, 16], 2)).toBe(false);
    expect(isAgyVersionAtLeast("1.5.16", [1, 5, 16], 2)).toBe(true);
    expect(isAgyVersionAtLeast("1.5.18", [1, 5, 16], 2)).toBe(true);
    expect(isAgyVersionAtLeast("1.6.0", [1, 5, 16], 2)).toBe(true);
    expect(isAgyVersionAtLeast("2.0.0", [1, 5, 16], 2)).toBe(false);
    expect(isAgyVersionAtLeast("unknown", [1, 5, 16], 2)).toBe(false);

    expect(resolveAgyUsageProfile("1.4.11")).toBeUndefined();
    expect(resolveAgyUsageProfile("1.4.12")).toEqual({ inputIncludesCache: true, outputIncludesReasoning: false });
    expect(resolveAgyUsageProfile("1.5.8")).toEqual({ inputIncludesCache: true, outputIncludesReasoning: false });
    expect(resolveAgyUsageProfile("1.5.9")).toEqual({ inputIncludesCache: false, outputIncludesReasoning: true });
    expect(resolveAgyUsageProfile("1.5.18")).toEqual({ inputIncludesCache: false, outputIncludesReasoning: true });
    expect(resolveAgyUsageProfile("2.0.0")).toBeUndefined();
    expect(resolveAgyUsageProfile("future")).toBeUndefined();
  });

  it.skipIf(Number(process.versions.node.split(".")[0]) < 22)("reads child conversation progress on 1.5.18+ and degrades cleanly on missing schema columns", async () => {
    const module = "node:sqlite";
    const { DatabaseSync } = await import(module);
    const root = mkdtempSync(join(tmpdir(), "agy-child-progress-")); roots.push(root);
    const directory = join(root, "antigravity-cli"); mkdirSync(directory);
    const dbPath = join(directory, "conversation_summaries.db");

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,status TEXT,not_fully_idle INTEGER,parent_conversation_id TEXT,step_count INTEGER,last_modified_time TEXT)");
      db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?)").run("parent-1", "CASCADE_RUN_STATUS_RUNNING", 1, "", 12, "2026-11-27 18:45:00.000+00:00");
      db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?)").run("child-a", "CASCADE_RUN_STATUS_RUNNING", 1, "parent-1", 40, "2026-11-27 18:46:00.000+00:00");
      db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?)").run("child-b", "CASCADE_RUN_STATUS_RUNNING", 1, "parent-1", 15, "2026-11-27 18:47:00.000+00:00");
      db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?)").run("other-child", "CASCADE_RUN_STATUS_RUNNING", 1, "parent-2", 99, "2026-11-27 18:48:00.000+00:00");

      const reader18 = new NativeSessionActivityReader(root, "parent-1", "1.5.18");
      expect(await reader18.activity()).toBe("running");
      expect(await reader18.childProgress()).toEqual([
        { conversationId: "child-b", stepCount: 15, lastModifiedTime: "2026-11-27 18:47:00.000+00:00" },
        { conversationId: "child-a", stepCount: 40, lastModifiedTime: "2026-11-27 18:46:00.000+00:00" },
      ]);
      expect(await new NativeSessionActivityReader(root, "parent-1", "1.5.15").childProgress()).toBeNull();
      expect(await new NativeSessionActivityReader(root, "parent-1", "2.0.0").childProgress()).toBeNull();
    } finally { db.close(); }

    const minimalRoot = mkdtempSync(join(tmpdir(), "agy-minimal-schema-")); roots.push(minimalRoot);
    mkdirSync(join(minimalRoot, "antigravity-cli"));
    const minimalDb = new DatabaseSync(join(minimalRoot, "antigravity-cli", "conversation_summaries.db"));
    try {
      minimalDb.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT)");
      const degraded = new NativeSessionActivityReader(minimalRoot, "parent-1", "1.5.18");
      expect(await degraded.activity()).toBe("unknown");
      expect(await degraded.childProgress()).toBeNull();
    } finally { minimalDb.close(); }
  });
});
