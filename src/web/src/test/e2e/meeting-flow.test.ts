import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sql, sqlQuery } from "../helpers/db"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
}, 60_000)
afterAll(() => {
  sql(`DELETE FROM meeting_session WHERE workspace_id = '${seed.workspaceId}'`)
  cleanupTestData(seed)
}, 60_000)

function req(path: string, opts?: RequestInit) {
  return tokenRequest(path, seed.machineToken, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  })
}

describe("meeting claim via poll", () => {
  it("poll returns no meetings when none are scheduled", async () => {
    const res = await req("/api/daemon/tasks/poll", {
      method: "POST",
      body: JSON.stringify({ daemon_id: seed.daemonId }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { meetings?: unknown[] }
    expect(data.meetings).toBeUndefined()
  })

  it("poll claims a scheduled meeting within 5-minute window", async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString()
    sql(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, scheduled_at, created_at, updated_at)
      VALUES ('ms_claim_test', '${seed.agentId}', '${seed.workspaceId}', 'Claim Test', 'https://meet.google.com/abc-defg-hij', 'scheduled', 1, '[]', '${pastTime}', '${pastTime}', '${pastTime}')`)

    const res = await req("/api/daemon/tasks/poll", {
      method: "POST",
      body: JSON.stringify({ daemon_id: seed.daemonId }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { meetings?: { id: string; meeting_url: string; agent_name: string }[] }
    expect(data.meetings).toBeDefined()
    expect(data.meetings!.length).toBe(1)
    expect(data.meetings![0].id).toBe("ms_claim_test")
    expect(data.meetings![0].meeting_url).toBe("https://meet.google.com/abc-defg-hij")
    expect(data.meetings![0].agent_name).toBeDefined()
  })

  it("does not re-claim already claimed meeting", async () => {
    const res = await req("/api/daemon/tasks/poll", {
      method: "POST",
      body: JSON.stringify({ daemon_id: seed.daemonId }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { meetings?: unknown[] }
    expect(data.meetings).toBeUndefined()
  })

  it("does not claim meetings far in the future", async () => {
    const futureTime = new Date(Date.now() + 3600_000).toISOString()
    sql(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, scheduled_at, created_at, updated_at)
      VALUES ('ms_future_test', '${seed.agentId}', '${seed.workspaceId}', 'Future Test', 'https://meet.google.com/xyz-wxyz-abc', 'scheduled', 1, '[]', '${futureTime}', '${futureTime}', '${futureTime}')`)

    const res = await req("/api/daemon/tasks/poll", {
      method: "POST",
      body: JSON.stringify({ daemon_id: seed.daemonId }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { meetings?: unknown[] }
    expect(data.meetings).toBeUndefined()
  })
})

describe("meeting callback flow", () => {
  let callbackMeetingId: string

  beforeAll(() => {
    callbackMeetingId = "ms_callback_test"
    const now = new Date().toISOString()
    sql(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, started_at, created_at, updated_at)
      VALUES ('${callbackMeetingId}', '${seed.agentId}', '${seed.workspaceId}', 'Callback Test', 'https://meet.google.com/abc-defg-hij', 'recording', 1, '["alice@test.com"]', '${now}', '${now}', '${now}')`)
  })

  it("POST /api/meeting/callback requires auth", async () => {
    const res = await tokenRequest(
      "/api/meeting/callback",
      "bad_token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: callbackMeetingId,
          workspaceId: seed.workspaceId,
          status: "completed",
          transcript: "test transcript",
        }),
      },
    )
    expect(res.status).toBe(401)
  })

  it("rejects mismatched workspace", async () => {
    const res = await req("/api/meeting/callback", {
      method: "POST",
      body: JSON.stringify({
        meetingId: callbackMeetingId,
        workspaceId: "wrong_workspace",
        status: "completed",
      }),
    })
    expect(res.status).toBe(403)
  })

  it("completes meeting and stores transcript", async () => {
    const res = await req("/api/meeting/callback", {
      method: "POST",
      body: JSON.stringify({
        meetingId: callbackMeetingId,
        workspaceId: seed.workspaceId,
        status: "completed",
        transcript: "[00:00:05] Alice:\nHello everyone",
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; meeting: { status: string; transcriptR2Key: string } }
    expect(data.ok).toBe(true)
    expect(data.meeting.status).toBe("completed")
    expect(data.meeting.transcriptR2Key).toContain(callbackMeetingId)
  })

  it("marks failed meetings", async () => {
    const failId = "ms_fail_test"
    const now = new Date().toISOString()
    sql(`INSERT INTO meeting_session (id, agent_id, workspace_id, title, meeting_url, status, is_whitelisted, participants, created_at, updated_at)
      VALUES ('${failId}', '${seed.agentId}', '${seed.workspaceId}', 'Fail Test', 'https://meet.google.com/abc-defg-hij', 'joining', 1, '[]', '${now}', '${now}')`)

    const res = await req("/api/meeting/callback", {
      method: "POST",
      body: JSON.stringify({
        meetingId: failId,
        workspaceId: seed.workspaceId,
        status: "failed",
        error: "Chrome crashed",
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { meeting: { status: string; error: string } }
    expect(data.meeting.status).toBe("failed")
    expect(data.meeting.error).toBe("Chrome crashed")
  })
})

describe("email notify with meetingInfo", () => {
  it("creates scheduled meeting for whitelisted sender with ICS", async () => {
    const res = await req("/api/email/notify", {
      method: "POST",
      body: JSON.stringify({
        agentId: seed.agentId,
        workspaceId: seed.workspaceId,
        r2Key: "emails/test-ics/raw",
        from: `${seed.userId}@test.local`,
        subject: "Meeting Invite",
        isWhitelisted: true,
        meetingInfo: {
          title: "Weekly Standup",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          startTime: "2026-05-01T10:00:00Z",
          endTime: "2026-05-01T11:00:00Z",
          attendees: [
            { name: "Alice", email: "alice@example.com" },
          ],
        },
      }),
    })
    expect(res.status).toBe(200)

    const rows = sqlQuery<{ status: string; title: string; meeting_url: string }>(
      `SELECT status, title, meeting_url FROM meeting_session WHERE workspace_id = '${seed.workspaceId}' AND title = 'Weekly Standup'`
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("scheduled")
    expect(rows[0].meeting_url).toBe("https://meet.google.com/abc-defg-hij")
  })

  it("creates pending meeting for non-whitelisted sender", async () => {
    const res = await req("/api/email/notify", {
      method: "POST",
      body: JSON.stringify({
        agentId: seed.agentId,
        workspaceId: seed.workspaceId,
        r2Key: "emails/test-ics-2/raw",
        from: "stranger@unknown.com",
        subject: "Unknown Invite",
        isWhitelisted: false,
        meetingInfo: {
          title: "Stranger Meeting",
          meetingUrl: "https://meet.google.com/xyz-wxyz-abc",
          startTime: "2026-05-02T10:00:00Z",
          endTime: null,
          attendees: [],
        },
      }),
    })
    expect(res.status).toBe(200)

    const rows = sqlQuery<{ status: string }>(
      `SELECT status FROM meeting_session WHERE workspace_id = '${seed.workspaceId}' AND title = 'Stranger Meeting'`
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("pending")
  })

  it("skips meeting creation when no meetingInfo", async () => {
    const countBefore = sqlQuery<{ cnt: number }>(
      `SELECT count(*) as cnt FROM meeting_session WHERE workspace_id = '${seed.workspaceId}'`
    )

    const res = await req("/api/email/notify", {
      method: "POST",
      body: JSON.stringify({
        agentId: seed.agentId,
        workspaceId: seed.workspaceId,
        r2Key: "emails/no-ics/raw",
        from: `${seed.userId}@test.local`,
        subject: "Plain Email",
        isWhitelisted: true,
      }),
    })
    expect(res.status).toBe(200)

    const countAfter = sqlQuery<{ cnt: number }>(
      `SELECT count(*) as cnt FROM meeting_session WHERE workspace_id = '${seed.workspaceId}'`
    )
    expect(countAfter[0].cnt).toBe(countBefore[0].cnt)
  })
})
