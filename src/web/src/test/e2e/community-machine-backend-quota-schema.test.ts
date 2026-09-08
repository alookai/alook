import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { sql, sqlQuery, sqlRun } from "@alook/test-utils"

const OWNER_ID = "e2e_backend_quota_owner"
const MACHINE_ID = "e2e_backend_quota_machine"
const SOURCE_EPOCH = "a".repeat(22)
const NOW = "2026-09-08T00:00:00.000Z"
const SUPPORTED_BACKENDS = ["claude", "codex", "grok"] as const

function insertQuota(agentBackendId: string): void {
  sqlRun(
    `INSERT INTO community_machine_backend_quota (
      machine_id, agent_backend_id, source_epoch, status, error_code,
      retryable, observed_at, updated_at
    ) VALUES (?, ?, ?, 'error', 'unavailable', 0, ?, ?)`,
    MACHINE_ID,
    agentBackendId,
    SOURCE_EPOCH,
    NOW,
    NOW,
  )
}

beforeEach(() => {
  sql("PRAGMA foreign_keys = ON")
  sqlRun(`DELETE FROM community_machine_backend_quota WHERE machine_id = ?`, MACHINE_ID)
  sqlRun(`DELETE FROM community_machine WHERE id = ?`, MACHINE_ID)
  sqlRun(`DELETE FROM user WHERE id = ?`, OWNER_ID)
  sqlRun(
    `INSERT INTO user (id, email, name) VALUES (?, ?, ?)`,
    OWNER_ID,
    `${OWNER_ID}@example.com`,
    "Backend Quota Owner",
  )
  sqlRun(
    `INSERT INTO community_machine (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    MACHINE_ID,
    OWNER_ID,
    NOW,
    NOW,
  )
})

afterAll(() => {
  sqlRun(`DELETE FROM community_machine_backend_quota WHERE machine_id = ?`, MACHINE_ID)
  sqlRun(`DELETE FROM community_machine WHERE id = ?`, MACHINE_ID)
  sqlRun(`DELETE FROM user WHERE id = ?`, OWNER_ID)
})

describe("community_machine_backend_quota.agent_backend_id CHECK", () => {
  it.each(SUPPORTED_BACKENDS)("admits supported backend '%s'", (backend) => {
    expect(() => insertQuota(backend)).not.toThrow()
    expect(
      sqlQuery<{ agent_backend_id: string }>(
        `SELECT agent_backend_id FROM community_machine_backend_quota WHERE machine_id = ?`,
        MACHINE_ID,
      ),
    ).toEqual([{ agent_backend_id: backend }])
  })

  it("rejects an unsupported backend", () => {
    expect(() => insertQuota("unsupported")).toThrow(/CHECK constraint failed/i)
  })
})
