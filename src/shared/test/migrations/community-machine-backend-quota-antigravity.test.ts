import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationDirectory = resolve(import.meta.dirname, "../../../web/migrations");
const epoch = "a".repeat(22);
const now = "2026-10-06T00:00:00.000Z";

function migrate(db: Sqlite.Database, name: string): void {
  db.transaction(() => db.exec(readFileSync(resolve(migrationDirectory, name), "utf8")))();
}

function insertError(db: Sqlite.Database, backend: string, machine = "machine_1"): void {
  db.prepare(`INSERT INTO community_machine_backend_quota (
    machine_id, agent_backend_id, source_epoch, status, error_code, retryable, observed_at, updated_at
  ) VALUES (?, ?, ?, 'error', 'network', 1, ?, ?)`).run(machine, backend, epoch, now, now);
}

function rows(db: Sqlite.Database): unknown[] {
  return db.prepare("SELECT * FROM community_machine_backend_quota ORDER BY machine_id, agent_backend_id").all();
}

describe("0105 Antigravity backend quota migration", () => {
  let db: Sqlite.Database;

  beforeEach(() => {
    db = new Sqlite(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_machine (id TEXT PRIMARY KEY);
      INSERT INTO community_machine VALUES ('machine_1'), ('machine_2');
    `);
    migrate(db, "0092_community_token_usage_quota.sql");
    migrate(db, "0097_community_machine_backend_quota_grok.sql");
    db.prepare(`INSERT INTO community_machine_backend_quota (
      machine_id, agent_backend_id, source_epoch, status, plan_name, fresh_for_seconds,
      limits, observed_at, updated_at
    ) VALUES ('machine_1', 'claude', ?, 'available', 'Existing plan', 300, ?, ?, ?)`).run(
      epoch, JSON.stringify([{ remainingFraction: 0.37 }]), now, "2026-10-06T00:01:00.000Z",
    );
    insertError(db, "codex");
    insertError(db, "grok");
    insertError(db, "grok", "machine_2");
  });

  afterEach(() => db.close());

  it("preserves every old row and admits both Antigravity observation states", () => {
    const before = rows(db);
    expect(() => insertError(db, "antigravity")).toThrow(/CHECK constraint failed/i);
    migrate(db, "0105_community_machine_backend_quota_antigravity.sql");
    expect(rows(db)).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    insertError(db, "antigravity");
    db.prepare(`INSERT INTO community_machine_backend_quota (
      machine_id, agent_backend_id, source_epoch, status, fresh_for_seconds, limits, observed_at, updated_at
    ) VALUES ('machine_2', 'antigravity', ?, 'available', 300, '[{}]', ?, ?)`).run(epoch, now, now);
    expect(db.prepare("SELECT status FROM community_machine_backend_quota WHERE agent_backend_id = 'antigravity' ORDER BY machine_id").all()).toEqual([
      { status: "error" }, { status: "available" },
    ]);
  });

  it("retains backend, epoch and observation validity constraints", () => {
    migrate(db, "0105_community_machine_backend_quota_antigravity.sql");
    expect(() => insertError(db, "unsupported")).toThrow(/CHECK constraint failed/i);
    insertError(db, "antigravity");
    for (const assignment of [
      "source_epoch = 'invalid'", "status = 'invalid'", "retryable = 2",
      "error_code = 'invalid'", "plan_name = 'invalid'", "limits = '[{}]'",
    ]) {
      expect(() => db.exec(`UPDATE community_machine_backend_quota SET ${assignment} WHERE agent_backend_id = 'antigravity'`)).toThrow(/CHECK constraint failed/i);
    }
    for (const assignment of [
      "fresh_for_seconds = 0", "fresh_for_seconds = 86401", "limits = '[]'",
      "limits = 'not-json'", "error_code = 'network'", "retryable = 1",
    ]) {
      expect(() => db.exec(`UPDATE community_machine_backend_quota SET ${assignment} WHERE agent_backend_id = 'claude'`)).toThrow(/CHECK constraint failed/i);
    }
  });

  it("retains composite uniqueness, machine foreign key and scoped cascade", () => {
    migrate(db, "0105_community_machine_backend_quota_antigravity.sql");
    insertError(db, "antigravity");
    expect(() => insertError(db, "antigravity")).toThrow(/UNIQUE constraint failed/i);
    expect(() => insertError(db, "antigravity", "missing")).toThrow(/FOREIGN KEY constraint failed/i);
    const sibling = db.prepare("SELECT * FROM community_machine_backend_quota WHERE machine_id = 'machine_2'").all();
    db.exec("DELETE FROM community_machine WHERE id = 'machine_1'");
    expect(rows(db)).toEqual(sibling);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
