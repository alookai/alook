import Sqlite from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_BACKENDS } from "../provider-telemetry";

const migrationDirectory = resolve(import.meta.dirname, "../../../web/migrations");
const precedingMigrations = readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql") && file < "0117_").sort().map((file) => readFileSync(resolve(migrationDirectory, file), "utf8"));

describe("machine backend plan migration", () => {
  let db: Sqlite.Database;
  let oldRows: unknown[];
  beforeEach(() => {
    db = new Sqlite(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of precedingMigrations) db.transaction(() => db.exec(migration))();
    db.exec("INSERT INTO user (id, email, name) VALUES ('owner', 'owner@example.com', 'Owner'), ('other-owner', 'other-owner@example.com', 'Other owner'); INSERT INTO community_machine (id, user_id, created_at, updated_at) VALUES ('machine', 'owner', '2026-11-16', '2026-11-16'), ('other-machine', 'other-owner', '2026-11-16', '2026-11-16');");
    db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'error', NULL, NULL, NULL, 'unavailable', 0, ?, ?)").run("machine", "codex-cli", "A".repeat(22), "2026-11-16", "2026-11-16");
    db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', 'Pro', 300, ?, NULL, NULL, ?, ?)").run("other-machine", "claude", "B".repeat(22), '[{"usedPercent":20}]', "2026-11-16", "2026-11-16");
    oldRows = db.prepare("SELECT * FROM community_machine_backend_quota ORDER BY machine_id, agent_backend_id").all();
    db.transaction(() => db.exec(readFileSync(resolve(migrationDirectory, "0117_community_machine_backend_quota_plans.sql"), "utf8")))();
  });
  afterEach(() => db.close());

  it("preserves old rows and admits every supported provider plan without fake quota", () => {
    expect(db.prepare("SELECT * FROM community_machine_backend_quota ORDER BY machine_id, agent_backend_id").all()).toEqual(oldRows);
    db.prepare("DELETE FROM community_machine_backend_quota").run();
    const insert = db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', ?, 300, '[]', NULL, NULL, ?, ?)");
    for (const backend of PROVIDER_QUOTA_BACKENDS) insert.run("machine", backend, "B".repeat(22), "Enterprise", "2026-11-16", "2026-11-16");
    expect(db.prepare("SELECT COUNT(*) AS count FROM community_machine_backend_quota").get()).toEqual({ count: PROVIDER_QUOTA_BACKENDS.length });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("DELETE FROM community_machine WHERE id = 'machine'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM community_machine_backend_quota").get()).toEqual({ count: 0 });
  });

  it("admits a future backend without a database allowlist", () => {
    db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', ?, 300, '[]', NULL, NULL, ?, ?)").run("machine", "future-unknown", "C".repeat(22), "Enterprise", "2026-11-16", "2026-11-16");
    expect(db.prepare("SELECT plan_name FROM community_machine_backend_quota WHERE agent_backend_id = 'future-unknown'").get()).toEqual({ plan_name: "Enterprise" });
  });

  it("retains primary keys, machine foreign keys and isolated cascade deletion", () => {
    const insert = db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, 'codex-cli', ?, 'error', NULL, NULL, NULL, 'unavailable', 0, ?, ?)");
    expect(() => insert.run("machine", "C".repeat(22), "2026-11-16", "2026-11-16")).toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run("absent", "C".repeat(22), "2026-11-16", "2026-11-16")).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("DELETE FROM community_machine WHERE id = 'machine'").run();
    expect(db.prepare("SELECT * FROM community_machine_backend_quota").all()).toEqual(oldRows.filter((row) => (row as { machine_id: string }).machine_id === "other-machine"));
  });

  it("rejects absent data and an empty or oversized plan-only success", () => {
    const insert = db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', ?, 300, ?, NULL, NULL, ?, ?)");
    for (const [backend, plan, limits] of [["cursor", null, "[]"], ["cursor", "", "[]"], ["cursor", "🙂".repeat(17), "[]"], ["cursor", "Pro", null], ["cursor", "Pro", "{}"]]) {
      expect(() => insert.run("machine", backend, "B".repeat(22), plan, limits, "2026-11-16", "2026-11-16")).toThrow();
    }
  });
});
