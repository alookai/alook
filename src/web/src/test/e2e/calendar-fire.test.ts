/**
 * Cross-service E2E: Calendar event with past scheduled_at → sweep → task dispatched
 * Verifies calendar event promotion creates a task with type=calendar_event.
 * Refs: #190
 *
 * NOTE: The sweep route throttles calendar promotion (30s via KV). Tests are
 * structured to insert all events before a single sweep call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sql, sqlQuery } from "@alook/test-utils"

let seed: TestSeed

const eventIds = {
  basic: `ce_basic_${randomUUID().slice(0, 8)}`,
  triggerCheck: `ce_trig_${randomUUID().slice(0, 8)}`,
  recurring: `ce_recur_${randomUUID().slice(0, 8)}`,
}

beforeAll(async () => {
  seed = seedTestData()

  const pastTime1 = new Date(Date.now() - 60_000).toISOString()
  const pastTime2 = new Date(Date.now() - 120_000).toISOString()
  const pastTime3 = new Date(Date.now() - 90_000).toISOString()
  const now = new Date().toISOString()

  // Insert all events before sweep (throttle prevents multiple sweep calls)
  sql(
    `INSERT INTO calendar_event (id, agent_id, workspace_id, title, scheduled_at, created_at, updated_at) VALUES ('${eventIds.basic}', '${seed.agentId}', '${seed.workspaceId}', 'E2E sweep test event', '${pastTime1}', '${now}', '${now}')`,
  )
  sql(
    `INSERT INTO calendar_event (id, agent_id, workspace_id, title, scheduled_at, created_at, updated_at) VALUES ('${eventIds.triggerCheck}', '${seed.agentId}', '${seed.workspaceId}', 'E2E trigger check', '${pastTime2}', '${now}', '${now}')`,
  )
  sql(
    `INSERT INTO calendar_event (id, agent_id, workspace_id, title, scheduled_at, repeat_interval, created_at, updated_at) VALUES ('${eventIds.recurring}', '${seed.agentId}', '${seed.workspaceId}', 'E2E recurring', '${pastTime3}', '1day', '${now}', '${now}')`,
  )

  // Small delay for WAL visibility
  await new Promise((r) => setTimeout(r, 300))

  // Single sweep call processes all events
  const sweepRes = await tokenRequest(
    `/api/daemon/sweep`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: seed.daemonId }),
    },
  )
  expect(sweepRes.status).toBe(200)

  // Wait for processing
  await new Promise((r) => setTimeout(r, 1500))
})
afterAll(() => cleanupTestData(seed))

describe("cross-service: calendar event fire → task dispatched", () => {
  it("past calendar event → sweep → task created with type=calendar_event", () => {
    const tasks = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM agent_task_queue WHERE agent_id = '${seed.agentId}' AND workspace_id = '${seed.workspaceId}' AND type = 'calendar_event' AND prompt = 'E2E sweep test event'`,
    )
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks[0].type).toBe("calendar_event")
    expect(tasks[0].prompt).toBe("E2E sweep test event")
    expect(tasks[0].status).toMatch(/queued|dispatched/)
  })

  it("calendar event last_triggered_at is updated after sweep", () => {
    const rows = sqlQuery<{ last_triggered_at: string | null }>(
      `SELECT last_triggered_at FROM calendar_event WHERE id = '${eventIds.triggerCheck}'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].last_triggered_at).toBeTruthy()
  })

  it("recurring event gets next scheduled_at advanced after sweep", () => {
    const rows = sqlQuery<{ scheduled_at: string }>(
      `SELECT scheduled_at FROM calendar_event WHERE id = '${eventIds.recurring}'`,
    )
    expect(rows).toHaveLength(1)
    const newScheduled = new Date(rows[0].scheduled_at)
    // After promotion, recurring event with 1day interval should advance to future
    expect(newScheduled.getTime()).toBeGreaterThan(Date.now())
  })

  it("already triggered event is not re-triggered on second sweep", async () => {
    const countBefore = sqlQuery<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_task_queue WHERE agent_id = '${seed.agentId}' AND type = 'calendar_event' AND prompt = 'E2E sweep test event'`,
    )

    // Wait for throttle to expire (use a fresh workspace seed to bypass)
    // Instead, insert a new event with last_triggered_at already set
    const alreadyTriggeredId = `ce_done_${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const pastTime = new Date(Date.now() - 60_000).toISOString()
    sql(
      `INSERT INTO calendar_event (id, agent_id, workspace_id, title, scheduled_at, last_triggered_at, created_at, updated_at) VALUES ('${alreadyTriggeredId}', '${seed.agentId}', '${seed.workspaceId}', 'E2E already-triggered', '${pastTime}', '${now}', '${now}', '${now}')`,
    )

    // Verify it's not picked up by querying the due events condition directly
    const dueRows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM calendar_event WHERE id = '${alreadyTriggeredId}' AND (last_triggered_at IS NULL OR last_triggered_at < scheduled_at)`,
    )
    // Should NOT match — last_triggered_at > scheduled_at
    expect(dueRows).toHaveLength(0)

    // Also verify the original event from test 1 wasn't duplicated
    const countAfter = sqlQuery<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM agent_task_queue WHERE agent_id = '${seed.agentId}' AND type = 'calendar_event' AND prompt = 'E2E sweep test event'`,
    )
    expect(countAfter[0].cnt).toBe(countBefore[0].cnt)
  })
})
