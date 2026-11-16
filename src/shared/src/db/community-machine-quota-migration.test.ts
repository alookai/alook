import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_BACKENDS } from "../provider-telemetry";

describe("machine backend plan migration", () => {
  let db: Sqlite.Database;
  beforeEach(() => {
    db = new Sqlite(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE community_machine (id TEXT PRIMARY KEY); INSERT INTO community_machine VALUES ('machine'); CREATE TABLE community_machine_backend_quota (machine_id TEXT, agent_backend_id TEXT, source_epoch TEXT, status TEXT, plan_name TEXT, fresh_for_seconds INTEGER, limits TEXT, error_code TEXT, retryable INTEGER, observed_at TEXT, updated_at TEXT);");
    db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'error', NULL, NULL, NULL, 'unavailable', 0, ?, ?)").run("machine", "codex-cli", "A".repeat(22), "2026-11-16", "2026-11-16");
    db.exec(readFileSync(resolve(import.meta.dirname, "../../../web/migrations/0117_community_machine_backend_quota_plans.sql"), "utf8"));
  });
  afterEach(() => db.close());

  it("preserves old rows and admits every supported provider plan without fake quota", () => {
    expect(db.prepare("SELECT agent_backend_id, source_epoch, error_code FROM community_machine_backend_quota").all()).toEqual([{ agent_backend_id: "codex-cli", source_epoch: "A".repeat(22), error_code: "unavailable" }]);
    db.prepare("DELETE FROM community_machine_backend_quota").run();
    const insert = db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', ?, 300, '[]', NULL, NULL, ?, ?)");
    for (const backend of PROVIDER_QUOTA_BACKENDS) insert.run("machine", backend, "B".repeat(22), "Enterprise", "2026-11-16", "2026-11-16");
    expect(db.prepare("SELECT COUNT(*) AS count FROM community_machine_backend_quota").get()).toEqual({ count: PROVIDER_QUOTA_BACKENDS.length });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("DELETE FROM community_machine WHERE id = 'machine'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM community_machine_backend_quota").get()).toEqual({ count: 0 });
  });

  it("rejects unknown backends, absent data and an empty or oversized plan-only success", () => {
    const insert = db.prepare("INSERT INTO community_machine_backend_quota VALUES (?, ?, ?, 'available', ?, 300, ?, NULL, NULL, ?, ?)");
    for (const [backend, plan, limits] of [["unknown", "Pro", "[]"], ["cursor", null, "[]"], ["cursor", "", "[]"], ["cursor", "🙂".repeat(17), "[]"], ["cursor", "Pro", null], ["cursor", "Pro", "{}"]]) {
      expect(() => insert.run("machine", backend, "B".repeat(22), plan, limits, "2026-11-16", "2026-11-16")).toThrow();
    }
  });
});
