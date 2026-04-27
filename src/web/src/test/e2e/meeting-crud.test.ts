import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sql } from "../helpers/db"

let seed: TestSeed
let seedB: TestSeed

beforeAll(() => {
  seed = seedTestData()
  seedB = seedTestData()
}, 60_000)
afterAll(() => {
  sql(`DELETE FROM meeting_session WHERE workspace_id = '${seed.workspaceId}'`)
  sql(`DELETE FROM meeting_session WHERE workspace_id = '${seedB.workspaceId}'`)
  cleanupTestData(seed)
  cleanupTestData(seedB)
}, 60_000)

function meetingReq(path: string, token: string, opts?: RequestInit) {
  return tokenRequest(path, token, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  })
}

describe("meeting CRUD", () => {
  let meetingId: string

  it("POST /api/agents/:id/meetings creates a scheduled meeting", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          title: "E2E Standup",
          participants: ["alice@example.com"],
          scheduledAt: "2026-05-01T10:00:00Z",
        }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBeTruthy()
    expect((data.id as string).startsWith("ms_")).toBe(true)
    expect(data.title).toBe("E2E Standup")
    expect(data.meeting_url).toBe("https://meet.google.com/abc-defg-hij")
    expect(data.status).toBe("scheduled")
    expect(data.is_whitelisted).toBe(true)
    meetingId = data.id as string
  })

  it("POST /api/agents/:id/meetings returns 400 for missing meetingUrl", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({ title: "No URL" }),
      },
    )
    expect(res.status).toBe(400)
  })

  it("POST /api/agents/:id/meetings returns 400 for invalid Meet URL", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({ meetingUrl: "https://zoom.us/j/123456" }),
      },
    )
    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(data.error).toContain("invalid")
  })

  it("GET /api/agents/:id/meetings returns list with the created meeting", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(1)
    expect(data.some((m) => m.id === meetingId)).toBe(true)
  })

  it("GET /api/agents/:id/meetings/:meetingId returns meeting detail", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${meetingId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(meetingId)
    expect(data.title).toBe("E2E Standup")
    expect(data.participants).toEqual(["alice@example.com"])
  })

  it("GET /api/agents/:id/meetings/:meetingId returns 404 for nonexistent", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/ms_nonexistent?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(404)
  })

  it("DELETE /api/agents/:id/meetings/:meetingId removes meeting", async () => {
    // Create a second meeting to delete
    const createRes = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/del-eted-one",
          title: "To Delete",
          scheduledAt: "2026-05-02T10:00:00Z",
        }),
      },
    )
    const created = await createRes.json() as Record<string, unknown>
    const deleteId = created.id as string

    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${deleteId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(200)

    // Verify gone
    const getRes = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${deleteId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(getRes.status).toBe(404)
  })
})

describe("meeting approve flow", () => {
  let pendingId: string

  beforeAll(() => {
    // Directly insert a pending meeting (simulating non-whitelisted ICS)
    const now = new Date().toISOString()
    pendingId = `ms_e2e_pending_${Date.now()}`
    sql(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, scheduled_at, created_at, updated_at) VALUES ('${pendingId}', '${seed.agentId}', '${seed.workspaceId}', 'Pending Meeting', 'https://meet.google.com/pen-ding-one', 'pending', 0, '[]', '2026-05-03T10:00:00Z', '${now}', '${now}')`)
  })

  it("POST /approve transitions pending → scheduled", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${pendingId}/approve?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("scheduled")
  })

  it("POST /approve on non-pending returns 400", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${pendingId}/approve?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(data.error).toContain("pending")
  })
})

describe("meeting stop on non-active", () => {
  it("POST /stop returns 400 when meeting is scheduled (not active)", async () => {
    // Create a scheduled meeting
    const createRes = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/sch-edul-one",
          title: "Scheduled Only",
          scheduledAt: "2026-06-01T10:00:00Z",
        }),
      },
    )
    const created = await createRes.json() as Record<string, unknown>

    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings/${created.id}/stop?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(data.error).toContain("not active")
  })
})

describe("meeting workspace isolation", () => {
  it("GET meetings from workspace B cannot see workspace A meetings", async () => {
    const res = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seedB.workspaceId}`,
      seedB.machineToken,
    )
    // Agent doesn't exist in workspace B, so should 404 or return empty
    const status = res.status
    if (status === 200) {
      const data = await res.json() as Array<Record<string, unknown>>
      expect(data).toHaveLength(0)
    } else {
      expect(status).toBe(404)
    }
  })

  it("DELETE meeting from wrong workspace returns 404", async () => {
    // Create in A
    const createRes = await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/iso-late-one",
          title: "Isolation Test",
          scheduledAt: "2026-07-01T10:00:00Z",
        }),
      },
    )
    const created = await createRes.json() as Record<string, unknown>

    // Try delete from B
    const res = await meetingReq(
      `/api/agents/${seedB.agentId}/meetings/${created.id}?workspace_id=${seedB.workspaceId}`,
      seedB.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })
})

describe("meeting in calendar API", () => {
  it("GET /api/calendar includes meetings with scheduled_at", async () => {
    // Create a meeting with scheduled_at in a known range
    await meetingReq(
      `/api/agents/${seed.agentId}/meetings?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        body: JSON.stringify({
          meetingUrl: "https://meet.google.com/cal-test-one",
          title: "Calendar Visible",
          scheduledAt: "2026-05-15T14:00:00Z",
        }),
      },
    )

    const res = await meetingReq(
      `/api/calendar?workspace_id=${seed.workspaceId}&from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    const meetingItems = data.filter((e) => (e as any)._type === "meeting")
    expect(meetingItems.length).toBeGreaterThanOrEqual(1)
    expect(meetingItems.some((m) => m.title === "Calendar Visible")).toBe(true)
  })
})
