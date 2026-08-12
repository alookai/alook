import { describe, expect, it, vi } from "vitest";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { Database } from "../../src/db";
import {
  DIAGNOSTIC_REPORT_FAILURE_CODES,
  communityDiagnosticReport,
  type DiagnosticReportFailureCode,
} from "../../src/db/community-machine-schema";
import * as q from "../../src/db/queries/community/diagnostic-report";

const NOW_MS = 1_786_531_200_000;
const FROM_MS = NOW_MS - 86_400_000;
const DEADLINE_AT = NOW_MS + 600_000;
const OWNER_ID = "owner_1";
const AGENT_ID = "agent_1";
const MACHINE_ID = "cm_machine_1";
const REPORT_ID = "dbr_report_1";
const NONCE = "nonce_1234567890abcdef";

const pendingRow = {
  id: REPORT_ID,
  ownerUserId: OWNER_ID,
  agentId: AGENT_ID,
  machineId: MACHINE_ID,
  clientNonce: NONCE,
  rateBucket: Math.floor(NOW_MS / 60_000),
  status: "pending" as const,
  failureCode: null,
  fromMs: FROM_MS,
  createdAt: NOW_MS,
  deadlineAt: DEADLINE_AT,
  completedAt: null,
  r2Key: null,
  sha256: null,
  sizeBytes: null,
  uploadedAt: null,
  objectExpiresAt: null,
};

function scriptedDb(steps: Array<{ method: string; rows: unknown[] }>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const db: Record<string, ReturnType<typeof vi.fn>> = {};
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const terminal = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    const step = steps.shift();
    if (!step || step.method !== method) {
      throw new Error(`unexpected terminal ${method}; expected ${step?.method ?? "none"}`);
    }
    return Promise.resolve(step.rows);
  };
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "limit", "insert", "values", "onConflictDoNothing", "update", "set"] as const) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.returning = vi.fn((...args: unknown[]) => terminal("returning", args));
  db.select = chain.select;
  db.insert = chain.insert;
  db.update = chain.update;
  return { db, chain, calls, remaining: steps };
}

function queryDb(resultRows: unknown[][]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => unknown;
  } = {};
  for (const method of [
    "select",
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "limit",
    "insert",
    "values",
    "onConflictDoNothing",
    "returning",
    "update",
    "set",
  ] as const) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.then = (resolve, reject) => {
    try {
      return Promise.resolve(resolve(resultRows.shift() ?? []));
    } catch (error) {
      return Promise.resolve(reject(error));
    }
  };
  return {
    db: { select: chain.select, insert: chain.insert, update: chain.update },
    chain,
    calls,
    remaining: resultRows,
  };
}

function realSnapshotDb(input: {
  ownerDeleted?: boolean;
  botDeleted?: boolean;
  isBot?: boolean;
  bound?: boolean;
} = {}) {
  const sqlite = new Sqlite(":memory:");
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL,
      ownerUserId TEXT,
      isBot INTEGER NOT NULL,
      deletedAt TEXT
    );
    CREATE TABLE community_bot_binding (
      user_id TEXT PRIMARY KEY NOT NULL,
      machine_id TEXT NOT NULL
    );
    CREATE TABLE community_diagnostic_report (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      client_nonce TEXT NOT NULL,
      rate_bucket INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_code TEXT,
      from_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      completed_at INTEGER,
      r2_key TEXT,
      sha256 TEXT,
      size_bytes INTEGER,
      uploaded_at INTEGER,
      object_expires_at INTEGER
    );
    CREATE UNIQUE INDEX uq_snapshot_owner_nonce
      ON community_diagnostic_report(owner_user_id, client_nonce);
    CREATE UNIQUE INDEX uq_snapshot_owner_pending
      ON community_diagnostic_report(owner_user_id, agent_id)
      WHERE status = 'pending';
    CREATE UNIQUE INDEX uq_snapshot_owner_rate
      ON community_diagnostic_report(owner_user_id, rate_bucket);
  `);
  sqlite
    .prepare(`INSERT INTO user (id, ownerUserId, isBot, deletedAt) VALUES (?, ?, ?, ?)`)
    .run(OWNER_ID, null, 0, input.ownerDeleted ? "deleted" : null);
  sqlite
    .prepare(`INSERT INTO user (id, ownerUserId, isBot, deletedAt) VALUES (?, ?, ?, ?)`)
    .run(AGENT_ID, OWNER_ID, input.isBot === false ? 0 : 1, input.botDeleted ? "deleted" : null);
  if (input.bound !== false) {
    sqlite
      .prepare(`INSERT INTO community_bot_binding (user_id, machine_id) VALUES (?, ?)`)
      .run(AGENT_ID, MACHINE_ID);
  }
  return {
    sqlite,
    db: drizzle(sqlite) as unknown as Database,
  };
}

describe("diagnostic report query contract", () => {
  it("keeps the Drizzle columns and indexes in exact migration parity", () => {
    const config = getTableConfig(communityDiagnosticReport);
    expect(
      config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType().toUpperCase(),
        notNull: column.notNull,
        primaryKey: column.primary,
      })),
    ).toEqual([
      { name: "id", type: "TEXT", notNull: true, primaryKey: true },
      { name: "owner_user_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "agent_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "machine_id", type: "TEXT", notNull: true, primaryKey: false },
      { name: "client_nonce", type: "TEXT", notNull: true, primaryKey: false },
      { name: "rate_bucket", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "status", type: "TEXT", notNull: true, primaryKey: false },
      { name: "failure_code", type: "TEXT", notNull: false, primaryKey: false },
      { name: "from_ms", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "created_at", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "deadline_at", type: "INTEGER", notNull: true, primaryKey: false },
      { name: "completed_at", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "r2_key", type: "TEXT", notNull: false, primaryKey: false },
      { name: "sha256", type: "TEXT", notNull: false, primaryKey: false },
      { name: "size_bytes", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "uploaded_at", type: "INTEGER", notNull: false, primaryKey: false },
      { name: "object_expires_at", type: "INTEGER", notNull: false, primaryKey: false },
    ]);
    expect(
      config.indexes
        .map((entry) => ({
          name: entry.config.name,
          columns: entry.config.columns.map((column) => column.name),
          unique: entry.config.unique,
          partial: entry.config.where !== undefined,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      {
        name: "idx_community_diagnostic_report_machine_status_deadline",
        columns: ["machine_id", "status", "deadline_at"],
        unique: false,
        partial: false,
      },
      {
        name: "idx_community_diagnostic_report_owner_created",
        columns: ["owner_user_id", "created_at"],
        unique: false,
        partial: false,
      },
      {
        name: "uq_community_diagnostic_report_owner_agent_pending",
        columns: ["owner_user_id", "agent_id"],
        unique: true,
        partial: true,
      },
      {
        name: "uq_community_diagnostic_report_owner_nonce",
        columns: ["owner_user_id", "client_nonce"],
        unique: true,
        partial: false,
      },
      {
        name: "uq_community_diagnostic_report_owner_rate_bucket",
        columns: ["owner_user_id", "rate_bucket"],
        unique: true,
        partial: false,
      },
    ]);
    expect(config.foreignKeys).toEqual([]);
  });

  it("exports the one failure-code source and the complete fixed allowlist", () => {
    expect(DIAGNOSTIC_REPORT_FAILURE_CODES).toEqual([
      "offline",
      "timeout",
      "upload_conflict",
      "invalid_upload",
      "diagnostics_unavailable",
      "collector_busy",
      "bot_not_bound",
      "collection_failed",
      "local_artifact_invalid",
      "bundle_too_large",
      "upload_failed",
      "internal_error",
    ]);
    expect(new Set(DIAGNOSTIC_REPORT_FAILURE_CODES).size).toBe(
      DIAGNOSTIC_REPORT_FAILURE_CODES.length,
    );
  });

  it("exports only the frozen B2a state-machine helpers", () => {
    expect(typeof q.createOrGetPendingDiagnosticReport).toBe("function");
    expect(typeof q.getDiagnosticReportForOwner).toBe("function");
    expect(typeof q.getPendingDiagnosticReportForMachine).toBe("function");
    expect(typeof q.getDiagnosticReportForMachine).toBe("function");
    expect(typeof q.timeoutPendingDiagnosticReport).toBe("function");
    expect(typeof q.failPendingDiagnosticReport).toBe("function");
    expect(typeof q.finalizeDiagnosticReportUpload).toBe("function");
  });

  it("first create is one atomic INSERT…SELECT from the live owner/bot/binding snapshot", async () => {
    const created = { ...pendingRow };
    const { db, chain } = queryDb([[created]]);

    const result = await q.createOrGetPendingDiagnosticReport(db, {
      ownerUserId: OWNER_ID,
      agentId: AGENT_ID,
      clientNonce: NONCE,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ kind: "created", report: created });
    // `machineId` is deliberately absent from caller input. The insert must
    // project owner/agent/machine from its live SQL snapshot, never from an
    // earlier JS lookup that can race soft-delete/unbind.
    expect(chain.values).not.toHaveBeenCalled();
    expect(chain.select).toHaveBeenCalledTimes(2);
    expect(chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("executes the typed INSERT…SELECT against one live owner/bot/binding snapshot", async () => {
    const { db, sqlite } = realSnapshotDb();
    try {
      const result = await q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      });
      expect(result.kind).toBe("created");
      expect(result.report).toMatchObject({
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        machineId: MACHINE_ID,
      });
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM community_diagnostic_report`).get(),
      ).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["deleted owner", { ownerDeleted: true }, OWNER_ID],
    ["wrong owner", {}, "owner_other"],
    ["non-bot target", { isBot: false }, OWNER_ID],
    ["deleted bot", { botDeleted: true }, OWNER_ID],
    ["missing binding", { bound: false }, OWNER_ID],
  ] as const)("atomically rejects %s without persisting a report", async (_name, setup, ownerUserId) => {
    const { db, sqlite } = realSnapshotDb(setup);
    try {
      await expect(
        q.createOrGetPendingDiagnosticReport(db, {
          ownerUserId,
          agentId: AGENT_ID,
          clientNonce: NONCE,
          nowMs: NOW_MS,
        }),
      ).rejects.toMatchObject({ code: "DIAGNOSTIC_TARGET_UNAVAILABLE" });
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS count FROM community_diagnostic_report`).get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["same_nonce", { ...pendingRow }, [[], [{ ...pendingRow }]]],
    [
      "existing_pending",
      { ...pendingRow, clientNonce: "nonce_other_123456" },
      [[], [], [{ ...pendingRow, clientNonce: "nonce_other_123456" }]],
    ],
    [
      "rate_limited",
      { ...pendingRow, status: "failed", failureCode: "timeout", completedAt: NOW_MS },
      [[], [], [], [{ ...pendingRow, status: "failed", failureCode: "timeout", completedAt: NOW_MS }]],
    ],
  ] as const)("returns authoritative %s row with its persisted fromMs", async (kind, row, rows) => {
    const { db } = queryDb(rows.map((value) => [...value]));
    const result = await q.createOrGetPendingDiagnosticReport(
      db,
      {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS + 42_000,
      },
    );
    expect(result).toEqual({ kind, report: row });
    expect(result.report.fromMs).toBe(FROM_MS);
  });

  it("classifies a conflicted insert in nonce → pending → rate order and retries insert at most once when the pending winner terminalized", async () => {
    const { db, chain, remaining } = queryDb([[], [], [], [], [pendingRow]]);

    await expect(
      q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual({ kind: "created", report: pendingRow });
    expect(chain.insert).toHaveBeenCalledTimes(2);
    expect(chain.select).toHaveBeenCalledTimes(7);
    expect(remaining).toEqual([]);
  });

  it("terminalizes a stale different-nonce pending row before retrying a replacement", async () => {
    const stale = {
      ...pendingRow,
      clientNonce: "nonce_stale_other_1234",
      deadlineAt: NOW_MS - 1,
    };
    const timedOut = {
      ...stale,
      status: "failed" as const,
      failureCode: "timeout" as const,
      completedAt: NOW_MS,
    };
    const replacement = { ...pendingRow, id: "dbr_replacement" };
    const { db, chain, remaining } = queryDb([
      [],
      [],
      [stale],
      [timedOut],
      [],
      [replacement],
    ]);

    await expect(
      q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual({ kind: "created", report: replacement });
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.insert).toHaveBeenCalledTimes(2);
    expect(remaining).toEqual([]);
  });

  it("terminalizes a stale same-nonce row while preserving nonce identity", async () => {
    const stale = { ...pendingRow, deadlineAt: NOW_MS - 1 };
    const timedOut = {
      ...stale,
      status: "failed" as const,
      failureCode: "timeout" as const,
      completedAt: NOW_MS,
    };
    const { db, chain, remaining } = queryDb([[], [stale], [timedOut]]);

    await expect(
      q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual({ kind: "same_nonce", report: timedOut });
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.insert).toHaveBeenCalledTimes(1);
    expect(remaining).toEqual([]);
  });

  it.each([
    ["same_nonce", [[], [], [], [], [], [{ ...pendingRow }]]],
    [
      "existing_pending",
      [[], [], [], [], [], [], [{ ...pendingRow, clientNonce: "nonce_race_other_1234" }]],
    ],
    [
      "rate_limited",
      [
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [{ ...pendingRow, status: "failed", failureCode: "timeout", completedAt: NOW_MS }],
      ],
    ],
  ] as const)("reclassifies a second-insert %s race before failing closed", async (kind, rows) => {
    const { db, chain, remaining } = queryDb(
      rows.map((value) => [...value]),
    );
    await expect(
      q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      }),
    ).resolves.toMatchObject({ kind });
    expect(chain.insert).toHaveBeenCalledTimes(2);
    expect(remaining).toEqual([]);
  });

  it("fails closed when the atomic INSERT…SELECT observes owner/bot soft-delete or unbind", async () => {
    const { db, chain } = queryDb([[], [], [], [], []]);

    await expect(
      q.createOrGetPendingDiagnosticReport(db, {
        ownerUserId: OWNER_ID,
        agentId: AGENT_ID,
        clientNonce: NONCE,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "DIAGNOSTIC_TARGET_UNAVAILABLE" });
    expect(chain.values).not.toHaveBeenCalled();
    expect(chain.insert).toHaveBeenCalledTimes(2);
    // Both attempts are atomic INSERT…SELECT snapshots. The caller never
    // supplies machineId, so an unbound/deleted target cannot leave a row.
    expect(chain.select).toHaveBeenCalled();
  });

  it("owner status is scoped only by immutable row owner", async () => {
    const { db, chain } = queryDb([[pendingRow]]);
    await expect(
      q.getDiagnosticReportForOwner(db, { reportId: REPORT_ID, ownerUserId: OWNER_ID }),
    ).resolves.toEqual(pendingRow);
    expect(chain.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(1);
    expect(chain.innerJoin).not.toHaveBeenCalled();
  });

  it("machine authorization is the immutable report snapshot, not a live bot binding", async () => {
    const { db, chain } = queryDb([[pendingRow]]);
    await expect(
      q.getPendingDiagnosticReportForMachine(db, {
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual(pendingRow);
    expect(chain.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(1);
    expect(chain.innerJoin).not.toHaveBeenCalled();
  });

  it("timeout is a guarded pending→failed CAS returning its winning row", async () => {
    const failed = {
      ...pendingRow,
      status: "failed" as const,
      failureCode: "timeout" as const,
      completedAt: DEADLINE_AT,
    };
    const { db, chain } = scriptedDb([{ method: "returning", rows: [failed] }]);
    await expect(
      q.timeoutPendingDiagnosticReport(db, {
        reportId: REPORT_ID,
        ownerUserId: OWNER_ID,
        nowMs: DEADLINE_AT,
      }),
    ).resolves.toEqual(failed);
    expect(chain.set).toHaveBeenCalledWith({
      status: "failed",
      failureCode: "timeout",
      completedAt: DEADLINE_AT,
    });
  });

  it.each(DIAGNOSTIC_REPORT_FAILURE_CODES)(
    "failure CAS accepts fixed code %s and returns null for a lost race",
    async (failureCode) => {
      const { db } = scriptedDb([{ method: "returning", rows: [] }]);
      await expect(
        q.failPendingDiagnosticReport(db, {
          reportId: REPORT_ID,
          machineId: MACHINE_ID,
          failureCode: failureCode as DiagnosticReportFailureCode,
          nowMs: NOW_MS,
        }),
      ).resolves.toBeNull();
    },
  );

  it("finalize CAS derives exact object expiry and returns the uploaded row", async () => {
    const uploaded = {
      ...pendingRow,
      status: "uploaded" as const,
      completedAt: NOW_MS,
      uploadedAt: NOW_MS,
      objectExpiresAt: NOW_MS + 604_800_000,
      r2Key: `bug-reports/${OWNER_ID}/${REPORT_ID}.ndjson.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 1234,
    };
    const { db, chain } = scriptedDb([{ method: "returning", rows: [uploaded] }]);
    await expect(
      q.finalizeDiagnosticReportUpload(db, {
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        r2Key: uploaded.r2Key,
        sha256: uploaded.sha256,
        sizeBytes: uploaded.sizeBytes,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual(uploaded);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "uploaded",
        completedAt: NOW_MS,
        uploadedAt: NOW_MS,
        objectExpiresAt: NOW_MS + 604_800_000,
      }),
    );
  });

  it("terminal readback retains enough metadata for same/different compensation", async () => {
    const expected = {
      r2Key: `bug-reports/${OWNER_ID}/${REPORT_ID}.ndjson.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 1234,
    };
    const uploadExpected = { status: "uploaded" as const, ...expected };
    expect(q.classifyDiagnosticReportTerminal({
      ...pendingRow,
      status: "uploaded",
      ...expected,
    }, uploadExpected)).toEqual({ kind: "uploaded_same" });
    expect(q.classifyDiagnosticReportTerminal({
      ...pendingRow,
      status: "uploaded",
      ...expected,
      sha256: "b".repeat(64),
    }, uploadExpected)).toEqual({ kind: "uploaded_different" });
    expect(q.classifyDiagnosticReportTerminal({
      ...pendingRow,
      status: "failed",
      failureCode: "upload_conflict",
    }, { status: "failed", failureCode: "upload_conflict" })).toEqual({ kind: "failed_same" });
    expect(q.classifyDiagnosticReportTerminal({
      ...pendingRow,
      status: "failed",
      failureCode: "upload_conflict",
    }, { status: "failed", failureCode: "invalid_upload" })).toEqual({ kind: "failed_different" });
    expect(q.classifyDiagnosticReportTerminal(pendingRow, uploadExpected)).toEqual({ kind: "pending" });
  });

  it("rejects finalize time whose exact object expiry is not a safe integer", async () => {
    const { db, chain } = scriptedDb([]);
    await expect(
      q.finalizeDiagnosticReportUpload(db, {
        reportId: REPORT_ID,
        machineId: MACHINE_ID,
        r2Key: `bug-reports/${OWNER_ID}/${REPORT_ID}.ndjson.gz`,
        sha256: "a".repeat(64),
        sizeBytes: 1234,
        nowMs: Number.MAX_SAFE_INTEGER - 604_800_000 + 1,
      }),
    ).rejects.toThrow(RangeError);
    expect(chain.update).not.toHaveBeenCalled();
  });
});
