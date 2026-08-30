import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DailyUsageSnapshot, ProviderQuotaSnapshot } from "@alook/shared";
import {
  prepareQuotaReplace,
  prepareUsagePrune,
  prepareMachineTimeZoneUpdate,
  prepareUsageUpsert,
} from "./provider-telemetry-persistence.js";

function d1Adapter(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return {
            run: () => statement.run(...values as never[]),
          };
        },
      };
    },
  } as unknown as D1Database;
}

function run(statement: D1PreparedStatement): void {
  (statement as unknown as { run(): unknown }).run();
}

function usage(
  botId: string,
  input: DailyUsageSnapshot["metrics"]["input"],
  output: DailyUsageSnapshot["metrics"]["output"],
  cache: DailyUsageSnapshot["metrics"]["cache"],
): DailyUsageSnapshot {
  return { botId, day: "2026-08-28", metrics: { input, output, cache } };
}

function quota(
  sourceEpoch: string,
  observation: Omit<ProviderQuotaSnapshot["observation"], "sourceEpoch">,
): ProviderQuotaSnapshot {
  return {
    agentBackendId: "codex",
    observation: { ...observation, sourceEpoch },
  };
}

describe("provider telemetry persistence SQL", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    db = d1Adapter(sqlite);
    sqlite.exec(`
      CREATE TABLE community_bot_binding (
        user_id TEXT PRIMARY KEY NOT NULL,
        machine_id TEXT NOT NULL
      );
      CREATE TABLE community_bot_daily_token_usage (
        bot_id TEXT NOT NULL,
        day TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_tokens INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, day)
      );
      CREATE TABLE community_machine (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        time_zone TEXT
      );
      CREATE TABLE community_machine_backend_quota (
        machine_id TEXT NOT NULL,
        agent_backend_id TEXT NOT NULL,
        source_epoch TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_name TEXT,
        fresh_for_seconds INTEGER,
        limits TEXT,
        error_code TEXT,
        retryable INTEGER,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, agent_backend_id)
      );
    `);
    sqlite.prepare("INSERT INTO community_bot_binding (user_id, machine_id) VALUES (?, ?)").run("bot_1", "machine_1");
    sqlite.prepare("INSERT INTO community_machine (id, user_id) VALUES (?, ?)").run("machine_1", "owner_1");
  });

  afterEach(() => sqlite.close());

  it("replaces the whole daily row with the daemon's latest snapshot", () => {
    const first = usage(
      "bot_1",
      10,
      null,
      5,
    );
    const replacement = usage(
      "bot_1",
      7,
      4,
      null,
    );

    run(prepareUsageUpsert(db, "machine_1", first, "2026-08-28T10:00:00.000Z"));
    run(prepareUsageUpsert(db, "machine_1", replacement, "2026-08-28T11:00:00.000Z"));

    expect(sqlite.prepare(`
      SELECT input_tokens, output_tokens, cache_tokens
      FROM community_bot_daily_token_usage
      WHERE bot_id = 'bot_1' AND day = '2026-08-28'
    `).get()).toEqual({
      input_tokens: 7,
      output_tokens: 4,
      cache_tokens: null,
    });
  });

  it("checks the current binding inside the usage statement", () => {
    sqlite.prepare("UPDATE community_bot_binding SET machine_id = ? WHERE user_id = ?").run("machine_2", "bot_1");

    run(prepareUsageUpsert(db, "machine_1", usage(
      "bot_1",
      9,
      3,
      1,
    ), "2026-08-28T10:00:00.000Z"));

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_bot_daily_token_usage").get()).toEqual({ count: 0 });
  });

  it("updates the authenticated computer timezone and keeps the two-day recovery margin", () => {
    for (const day of ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-29", "2026-08-30"]) {
      const snapshot = { ...usage("bot_1", 1, 2, 3), day };
      run(prepareUsageUpsert(db, "machine_1", snapshot, "2026-08-29T16:00:01.000Z"));
    }

    run(prepareMachineTimeZoneUpdate(db, {
      machineId: "machine_1",
      userId: "owner_1",
    }, "Asia/Shanghai"));
    run(prepareUsagePrune(db, "machine_1", "bot_1", "2026-08-22"));

    expect(sqlite.prepare(`
      SELECT time_zone
      FROM community_machine
      WHERE id = 'machine_1'
    `).get()).toEqual({ time_zone: "Asia/Shanghai" });
    expect(sqlite.prepare(`
      SELECT day
      FROM community_bot_daily_token_usage
      ORDER BY day
    `).all()).toEqual([
      { day: "2026-08-22" },
      { day: "2026-08-23" },
      { day: "2026-08-29" },
      { day: "2026-08-30" },
    ]);
  });

  it("cannot update timezone or prune through a stale machine binding", () => {
    run(prepareUsageUpsert(db, "machine_1", usage("bot_1", 1, 2, 3), "2026-08-28T10:00:00.000Z"));
    sqlite.prepare("UPDATE community_bot_binding SET machine_id = ? WHERE user_id = ?").run("machine_2", "bot_1");

    run(prepareMachineTimeZoneUpdate(db, {
      machineId: "machine_1",
      userId: "wrong_owner",
    }, "Asia/Shanghai"));
    run(prepareUsagePrune(db, "machine_1", "bot_1", "2026-08-29"));

    expect(sqlite.prepare(`
      SELECT time_zone
      FROM community_machine
      WHERE id = 'machine_1'
    `).get()).toEqual({ time_zone: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_bot_daily_token_usage").get()).toEqual({ count: 1 });
  });

  it("retains a same-source success on transient error and replaces it for a new source", () => {
    const available = quota("A".repeat(22), {
      status: "available",
      planName: "Plus",
      freshForSeconds: 300,
      limits: [{
        bucket: {
          limitId: "primary",
          product: { kind: "reported", id: "codex", displayName: "Codex" },
          model: { kind: "not_applicable" },
          window: { kind: "rolling", durationSeconds: 18_000, displayName: "5 hours" },
        },
        usedPercent: 25,
      }],
    });
    const sameSourceError = quota("A".repeat(22), { status: "error", code: "network", retryable: true });
    const newSourceError = quota("B".repeat(22), { status: "error", code: "unauthorized", retryable: false });

    run(prepareQuotaReplace(db, { machineId: "machine_1", userId: "owner_1" }, available, "2026-08-28T10:00:00.000Z"));
    run(prepareQuotaReplace(db, { machineId: "machine_1", userId: "owner_1" }, sameSourceError, "2026-08-28T10:01:00.000Z"));
    expect(sqlite.prepare(`
      SELECT source_epoch, status, plan_name, error_code
      FROM community_machine_backend_quota
    `).get()).toEqual({ source_epoch: "A".repeat(22), status: "available", plan_name: "Plus", error_code: null });

    run(prepareQuotaReplace(db, { machineId: "machine_1", userId: "owner_1" }, newSourceError, "2026-08-28T10:02:00.000Z"));
    expect(sqlite.prepare(`
      SELECT source_epoch, status, plan_name, error_code
      FROM community_machine_backend_quota
    `).get()).toEqual({ source_epoch: "B".repeat(22), status: "error", plan_name: null, error_code: "unauthorized" });
  });
});
