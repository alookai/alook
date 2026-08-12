import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { sql, sqlQuery, sqlRun } from "@alook/test-utils"

const TABLE = "community_diagnostic_report"
const OWNER = "e2e_diag_owner"
const AGENT = "e2e_diag_agent"
const MACHINE = "cm_e2e_diag_machine"
const CREATED = 1_786_531_200_000
const FROM = CREATED - 86_400_000
const DEADLINE = CREATED + 600_000
const REPORT = "dbr_e2e_report"
const NONCE = "nonce_e2e_1234567890"
const SHA = "a".repeat(64)
const KEY = `bug-reports/${OWNER}/${REPORT}.ndjson.gz`

const FAILURE_CODES = [
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
] as const

type Overrides = Partial<{
  id: string
  ownerUserId: string
  agentId: string
  machineId: string
  clientNonce: string
  rateBucket: number
  status: string
  failureCode: string | null
  fromMs: number
  createdAt: number
  deadlineAt: number
  completedAt: number | null
  r2Key: string | null
  sha256: string | null
  sizeBytes: number | null
  uploadedAt: number | null
  objectExpiresAt: number | null
}>

function tableExists(): boolean {
  return sqlQuery<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    TABLE,
  ).length === 1
}

function clearReports(): void {
  if (tableExists()) sqlRun(`DELETE FROM ${TABLE}`)
}

function insertReport(overrides: Overrides = {}): void {
  const row = {
    id: REPORT,
    ownerUserId: OWNER,
    agentId: AGENT,
    machineId: MACHINE,
    clientNonce: NONCE,
    rateBucket: Math.floor(CREATED / 60_000),
    status: "pending",
    failureCode: null,
    fromMs: FROM,
    createdAt: CREATED,
    deadlineAt: DEADLINE,
    completedAt: null,
    r2Key: null,
    sha256: null,
    sizeBytes: null,
    uploadedAt: null,
    objectExpiresAt: null,
    ...overrides,
  }
  sqlRun(
    `INSERT INTO ${TABLE} (
      id, owner_user_id, agent_id, machine_id, client_nonce, rate_bucket,
      status, failure_code, from_ms, created_at, deadline_at, completed_at,
      r2_key, sha256, size_bytes, uploaded_at, object_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.ownerUserId,
    row.agentId,
    row.machineId,
    row.clientNonce,
    row.rateBucket,
    row.status,
    row.failureCode,
    row.fromMs,
    row.createdAt,
    row.deadlineAt,
    row.completedAt,
    row.r2Key,
    row.sha256,
    row.sizeBytes,
    row.uploadedAt,
    row.objectExpiresAt,
  )
}

function upload(reportId = REPORT, uploadedAt = CREATED + 1_000): void {
  sqlRun(
    `UPDATE ${TABLE}
       SET status='uploaded', completed_at=?, r2_key=?, sha256=?, size_bytes=?,
           uploaded_at=?, object_expires_at=?
     WHERE id=?`,
    uploadedAt,
    KEY,
    SHA,
    1234,
    uploadedAt,
    uploadedAt + 604_800_000,
    reportId,
  )
}

beforeEach(() => {
  sql("PRAGMA foreign_keys = ON")
  clearReports()
})

afterAll(clearReports)

describe("community_diagnostic_report migration parity", () => {
  it("installs the exact B2a table", () => {
    expect(tableExists()).toBe(true)
  })

  it("has the frozen columns, INTEGER epoch fields, and nullability", () => {
    const columns = sqlQuery<{
      name: string
      type: string
      notnull: number
      pk: number
    }>(`PRAGMA table_info(${TABLE})`)
    expect(columns.map((c) => [c.name, c.type.toUpperCase(), c.notnull, c.pk])).toEqual([
      ["id", "TEXT", 1, 1],
      ["owner_user_id", "TEXT", 1, 0],
      ["agent_id", "TEXT", 1, 0],
      ["machine_id", "TEXT", 1, 0],
      ["client_nonce", "TEXT", 1, 0],
      ["rate_bucket", "INTEGER", 1, 0],
      ["status", "TEXT", 1, 0],
      ["failure_code", "TEXT", 0, 0],
      ["from_ms", "INTEGER", 1, 0],
      ["created_at", "INTEGER", 1, 0],
      ["deadline_at", "INTEGER", 1, 0],
      ["completed_at", "INTEGER", 0, 0],
      ["r2_key", "TEXT", 0, 0],
      ["sha256", "TEXT", 0, 0],
      ["size_bytes", "INTEGER", 0, 0],
      ["uploaded_at", "INTEGER", 0, 0],
      ["object_expires_at", "INTEGER", 0, 0],
    ])
  })

  it("has exact named concurrency/query indexes", () => {
    const rows = sqlQuery<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`,
      TABLE,
    )
    expect(rows.map((r) => r.name)).toEqual([
      "idx_community_diagnostic_report_machine_status_deadline",
      "idx_community_diagnostic_report_owner_created",
      "uq_community_diagnostic_report_owner_agent_pending",
      "uq_community_diagnostic_report_owner_nonce",
      "uq_community_diagnostic_report_owner_rate_bucket",
    ])
    expect(rows.find((r) => r.name.endsWith("owner_agent_pending"))?.sql).toMatch(
      /WHERE\s+status\s*=\s*'pending'/i,
    )
  })

  it("stores no FK that can pin or cascade-delete bot/machine snapshots", () => {
    expect(tableExists()).toBe(true)
    expect(sqlQuery(`PRAGMA foreign_key_list(${TABLE})`)).toEqual([])
  })
})

describe("epoch-ms and relational CHECK constraints", () => {
  it("admits one canonical pending row", () => {
    expect(() => insertReport()).not.toThrow()
    const [row] = sqlQuery<Record<string, unknown>>(
      `SELECT *, typeof(from_ms) AS from_type, typeof(created_at) AS created_type,
               typeof(deadline_at) AS deadline_type
         FROM ${TABLE} WHERE id=?`,
      REPORT,
    )
    expect(row).toMatchObject({
      status: "pending",
      from_ms: FROM,
      created_at: CREATED,
      deadline_at: DEADLINE,
      from_type: "integer",
      created_type: "integer",
      deadline_type: "integer",
    })
  })

  it.each([
    ["bad report prefix", { id: "report_e2e" }],
    ["empty report suffix", { id: "dbr_" }],
    ["nonce shorter than 16", { clientNonce: "short_nonce" }],
    ["nonce longer than 64", { clientNonce: "n".repeat(65) }],
    ["nonce with punctuation", { clientNonce: "nonce.invalid.value!" }],
  ])("rejects invalid identity shape: %s", (_name, overrides) => {
    expect(() => insertReport(overrides)).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["fractional", Math.floor(CREATED / 60_000) + 0.5],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["wrong canonical minute", Math.floor(CREATED / 60_000) + 1],
  ])("rejects %s rate_bucket", (_name, rateBucket) => {
    expect(() => insertReport({ rateBucket })).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["fractional createdAt", { createdAt: CREATED + 0.5 }],
    ["negative createdAt", { createdAt: -1, fromMs: -86_400_001, deadlineAt: 599_999 }],
    ["unsafe createdAt", { createdAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong fromMs", { fromMs: FROM + 1 }],
    ["wrong deadlineAt", { deadlineAt: DEADLINE + 1 }],
    ["free-text status", { status: "collecting" }],
    ["pending failure", { failureCode: "timeout" }],
    ["pending completion", { completedAt: CREATED }],
    ["pending object key", { r2Key: KEY }],
    ["pending checksum", { sha256: SHA }],
    ["pending size", { sizeBytes: 1 }],
    ["pending uploadedAt", { uploadedAt: CREATED }],
    ["pending object expiry", { objectExpiresAt: CREATED }],
  ] as const)("rejects %s", (_name, overrides) => {
    expect(() => insertReport(overrides)).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["from fractional", { fromMs: FROM + 0.5 }],
    ["from negative", { fromMs: -1 }],
    ["from unsafe", { fromMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["deadline fractional", { deadlineAt: DEADLINE + 0.5 }],
    ["deadline negative", { deadlineAt: -1 }],
    ["deadline unsafe", { deadlineAt: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects non-canonical required epoch: %s", (_name, overrides) => {
    expect(() => insertReport(overrides)).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["completed fractional", CREATED + 0.5],
    ["completed negative", -1],
    ["completed unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects non-canonical nullable failed epoch: %s", (_name, completedAt) => {
    expect(() =>
      insertReport({ status: "failed", failureCode: "timeout", completedAt }),
    ).toThrow(/CHECK constraint failed/i)
  })

  it.each(FAILURE_CODES)("admits fixed failed code %s", (failureCode) => {
    expect(() =>
      insertReport({
        id: `dbr_${failureCode}`,
        clientNonce: `nonce_${failureCode}_12345678`,
        failureCode,
        status: "failed",
        completedAt: CREATED + 1,
      }),
    ).not.toThrow()
  })

  it.each([
    ["unknown failure", { failureCode: "secret_detail" }],
    ["failed without completion", { completedAt: null }],
    ["failed before create", { completedAt: CREATED - 1 }],
    ["failed with key", { r2Key: KEY }],
    ["failed with sha", { sha256: SHA }],
    ["failed with size", { sizeBytes: 1 }],
    ["failed with uploadedAt", { uploadedAt: CREATED }],
    ["failed with object expiry", { objectExpiresAt: CREATED }],
  ] as const)("rejects %s", (_name, overrides) => {
    expect(() =>
      insertReport({ status: "failed", failureCode: "timeout", completedAt: CREATED + 1, ...overrides }),
    ).toThrow(/CHECK constraint failed/i)
  })

  it("admits one coherent uploaded row", () => {
    expect(() =>
      insertReport({
        status: "uploaded",
        completedAt: CREATED + 1,
        r2Key: KEY,
        sha256: SHA,
        sizeBytes: 1234,
        uploadedAt: CREATED + 1,
        objectExpiresAt: CREATED + 1 + 604_800_000,
      }),
    ).not.toThrow()
  })

  it.each([
    ["uploaded failure", { failureCode: "upload_failed" }],
    ["missing key", { r2Key: null }],
    ["bad sha case", { sha256: "A".repeat(64) }],
    ["bad sha length", { sha256: "a".repeat(63) }],
    ["wrong object key", { r2Key: `bug-reports/${OWNER}/other.ndjson.gz` }],
    ["zero size", { sizeBytes: 0 }],
    ["completion mismatch", { completedAt: CREATED + 2 }],
    ["expiry mismatch", { objectExpiresAt: CREATED + 2 + 604_800_000 }],
  ] as const)("rejects incoherent uploaded row: %s", (_name, overrides) => {
    expect(() =>
      insertReport({
        status: "uploaded",
        completedAt: CREATED + 1,
        r2Key: KEY,
        sha256: SHA,
        sizeBytes: 1234,
        uploadedAt: CREATED + 1,
        objectExpiresAt: CREATED + 1 + 604_800_000,
        ...overrides,
      }),
    ).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["uploaded fractional", { uploadedAt: CREATED + 0.5, completedAt: CREATED + 0.5, objectExpiresAt: CREATED + 0.5 + 604_800_000 }],
    ["uploaded negative", { uploadedAt: -1, completedAt: -1, objectExpiresAt: 604_799_999 }],
    ["uploaded unsafe", { uploadedAt: Number.MAX_SAFE_INTEGER + 1, completedAt: Number.MAX_SAFE_INTEGER + 1, objectExpiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["expiry fractional", { objectExpiresAt: CREATED + 1 + 604_800_000 + 0.5 }],
    ["expiry negative", { objectExpiresAt: -1 }],
    ["expiry unsafe", { objectExpiresAt: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects non-canonical nullable uploaded epoch: %s", (_name, overrides) => {
    expect(() =>
      insertReport({
        status: "uploaded",
        completedAt: CREATED + 1,
        r2Key: KEY,
        sha256: SHA,
        sizeBytes: 1234,
        uploadedAt: CREATED + 1,
        objectExpiresAt: CREATED + 1 + 604_800_000,
        ...overrides,
      }),
    ).toThrow(/CHECK constraint failed/i)
  })

  it.each([
    ["fractional", 1.5],
    ["zero", 0],
    ["over 10 MiB", 10 * 1024 * 1024 + 1],
  ])("rejects %s uploaded sizeBytes", (_name, sizeBytes) => {
    expect(() =>
      insertReport({
        status: "uploaded",
        completedAt: CREATED + 1,
        r2Key: KEY,
        sha256: SHA,
        sizeBytes,
        uploadedAt: CREATED + 1,
        objectExpiresAt: CREATED + 1 + 604_800_000,
      }),
    ).toThrow(/CHECK constraint failed/i)
  })
})

describe("constraint-authoritative concurrency", () => {
  it("owner+nonce is globally unique", () => {
    insertReport()
    expect(() => insertReport({ id: "dbr_nonce_2", agentId: "agent_2" })).toThrow(
      /UNIQUE constraint failed/i,
    )
  })

  it("owner+agent has at most one pending row across minutes", () => {
    insertReport()
    expect(() =>
      insertReport({
        id: "dbr_pending_2",
        clientNonce: "nonce_pending_2_1234",
        createdAt: CREATED + 60_000,
        fromMs: FROM + 60_000,
        deadlineAt: DEADLINE + 60_000,
        rateBucket: Math.floor(CREATED / 60_000) + 1,
      }),
    ).toThrow(/UNIQUE constraint failed/i)
  })

  it("owner+rate bucket remains unique after the first row terminalizes", () => {
    insertReport()
    sqlRun(
      `UPDATE ${TABLE} SET status='failed', failure_code='timeout', completed_at=? WHERE id=?`,
      CREATED + 1,
      REPORT,
    )
    expect(() =>
      insertReport({
        id: "dbr_rate_2",
        agentId: "agent_2",
        clientNonce: "nonce_rate_2_1234567",
      }),
    ).toThrow(/UNIQUE constraint failed/i)
  })

  it("next minute succeeds after the prior pending row terminalizes", () => {
    insertReport()
    sqlRun(
      `UPDATE ${TABLE} SET status='failed', failure_code='timeout', completed_at=? WHERE id=?`,
      CREATED + 1,
      REPORT,
    )
    expect(() =>
      insertReport({
        id: "dbr_next_minute",
        clientNonce: "nonce_next_min_123456",
        createdAt: CREATED + 60_000,
        fromMs: FROM + 60_000,
        deadlineAt: DEADLINE + 60_000,
        rateBucket: Math.floor(CREATED / 60_000) + 1,
      }),
    ).not.toThrow()
  })
})

describe("UPDATE trigger enforces immutable snapshots and terminal rows", () => {
  it.each([
    ["no-op", `UPDATE ${TABLE} SET status=status WHERE id=?`],
    ["owner", `UPDATE ${TABLE} SET owner_user_id='other' WHERE id=?`],
    ["agent", `UPDATE ${TABLE} SET agent_id='other' WHERE id=?`],
    ["machine", `UPDATE ${TABLE} SET machine_id='cm_other' WHERE id=?`],
    ["from", `UPDATE ${TABLE} SET from_ms=from_ms+1 WHERE id=?`],
    ["nonce", `UPDATE ${TABLE} SET client_nonce='nonce_other_12345678' WHERE id=?`],
    ["bucket", `UPDATE ${TABLE} SET rate_bucket=rate_bucket+1 WHERE id=?`],
    ["created", `UPDATE ${TABLE} SET created_at=created_at+1 WHERE id=?`],
    ["deadline", `UPDATE ${TABLE} SET deadline_at=deadline_at+1 WHERE id=?`],
  ])("rejects pending→pending %s UPDATE", (_name, statement) => {
    insertReport()
    expect(() => sqlRun(statement, REPORT)).toThrow(/diagnostic.*immutable|constraint/i)
  })

  it("allows exactly one coherent pending→uploaded transition", () => {
    insertReport()
    expect(() => upload()).not.toThrow()
    expect(() => upload()).toThrow(/diagnostic.*immutable|constraint/i)
  })

  it("allows exactly one coherent pending→failed transition", () => {
    insertReport()
    expect(() =>
      sqlRun(
        `UPDATE ${TABLE} SET status='failed', failure_code='timeout', completed_at=? WHERE id=?`,
        CREATED + 1,
        REPORT,
      ),
    ).not.toThrow()
    expect(() =>
      sqlRun(`UPDATE ${TABLE} SET failure_code='offline' WHERE id=?`, REPORT),
    ).toThrow(/diagnostic.*immutable|constraint/i)
  })

  it("rejects pending→uploaded when relational fields are incomplete", () => {
    insertReport()
    expect(() =>
      sqlRun(`UPDATE ${TABLE} SET status='uploaded' WHERE id=?`, REPORT),
    ).toThrow(/CHECK constraint failed/i)
  })
})
