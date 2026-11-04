/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { createDb, EmailNotifyRequestSchema, parseIcs, queries } from "@alook/shared"

const ANCIENT_MONTHLY_ZONE = `BEGIN:VTIMEZONE
TZID:Ancient/Monthly
BEGIN:DAYLIGHT
DTSTART:10000101T000000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=MONTHLY;BYMONTHDAY=1
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:10000115T000000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15
END:STANDARD
END:VTIMEZONE`

const runtimeEnv = env as unknown as {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  IMAP_POLLER: DurableObjectNamespace
}

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

describe("email-worker workerd runtime", () => {
  it.each([
    { name: "overlap", start: "20071104T013000", embedded: true, expected: "2007-11-04T05:30:00.000Z", before: "2007-11-04T05:29:59.999Z", status: "scheduled" },
    { name: "gap", start: "20070311T023000", embedded: true, expected: "2007-03-11T07:30:00.000Z", before: "2007-03-11T07:29:59.999Z", status: "scheduled" },
    { name: "exhausted ancient monthly recurrence", start: "20260610T100000", embedded: true, zoneOverride: ANCIENT_MONTHLY_ZONE, tzid: "Ancient/Monthly", expected: null, before: "2026-06-10T08:59:59.999Z", status: "pending" },
    { name: "unresolved bare IANA", start: "20071104T013000", embedded: false, expected: null, before: "2007-11-04T05:29:59.999Z", status: "pending" },
  ])("persists qualified invitation time in real D1: $name", async ({ start, embedded, zoneOverride, tzid = "America/New_York", expected, before, status }) => {
    const zone = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:DAYLIGHT",
      "DTSTART:20070311T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "DTSTART:20061105T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE"].join("\n")
    const invitation = ["BEGIN:VCALENDAR", "VERSION:2.0", embedded ? zoneOverride ?? zone : "", "BEGIN:VEVENT",
      `DTSTART;TZID=${tzid}:${start}`, "SUMMARY:Runtime invitation",
      "LOCATION:https://meet.google.com/abc-defg-hij", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\n")
    const workspaceId = `ics-${crypto.randomUUID()}`
    const now = "2026-11-04T00:00:00.000Z"
    try {
      await runtimeEnv.DB.prepare("INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'ICS', ?, ?, ?)")
        .bind(workspaceId, workspaceId, now, now).run()
      const db = createDb(runtimeEnv.DB)
      const agent = await queries.agent.createAgent(db, { workspaceId, name: "ICS agent" })
      const notification = EmailNotifyRequestSchema.parse({
        agentId: agent.id, workspaceId, r2Key: "runtime/unsubmitted-email",
        from: "sender@example.test", subject: "Runtime invitation", isWhitelisted: true,
        meetingInfo: parseIcs(invitation),
      })
      const info = notification.meetingInfo
      expect(info).toBeDefined()
      if (!info) throw new Error("invitation metadata missing")
      expect(info.startTime).toBe(expected)
      const meeting = await queries.meetingSession.createMeetingSession(db, {
        agentId: agent.id, workspaceId, meetingUrl: info.meetingUrl, title: info.title,
        status, scheduledAt: info.startTime, isWhitelisted: true,
      })
      expect(meeting.status).toBe(status)
      expect(meeting.scheduledAt).toBe(expected)
      expect((await queries.meetingSession.getMeetingSession(db, meeting.id, workspaceId))?.scheduledAt).toBe(expected)
      expect(await queries.meetingSession.listScheduledMeetings(db, workspaceId, before)).toEqual([])
      expect((await queries.meetingSession.listScheduledMeetings(db, workspaceId, expected ?? now)).map(row => row.id))
        .toEqual(expected === null ? [] : [meeting.id])
    } finally {
      await runtimeEnv.DB.prepare("DELETE FROM workspace WHERE id = ?").bind(workspaceId).run()
    }
  })

  it("loads production migrations and serves the production entrypoint", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("agent_email_account").first<{ name: string }>()
    expect(schema?.name).toBe("agent_email_account")

    const response = await worker.fetch(new Request("https://worker.test/health"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("reads and writes through the real email R2 binding", async () => {
    const key = `runtime/${crypto.randomUUID()}`
    await runtimeEnv.EMAIL_BUCKET.put(key, "runtime email")

    const stored = await runtimeEnv.EMAIL_BUCKET.get(key)
    expect(stored).not.toBeNull()
    await expect(stored!.text()).resolves.toBe("runtime email")

    await runtimeEnv.EMAIL_BUCKET.delete(key)
    await expect(runtimeEnv.EMAIL_BUCKET.get(key)).resolves.toBeNull()
  })

  it("rejects unsupported methods, paths, and missing IMAP account ids", async () => {
    const unknown = await worker.fetch(new Request("https://worker.test/unknown", {
      method: "POST",
    }))
    expect(unknown.status).toBe(404)

    const method = await worker.fetch(new Request("https://worker.test/send/otp"))
    expect(method.status).toBe(405)

    const missingAccount = await worker.fetch(new Request("https://worker.test/imap/start", {
      method: "POST",
    }))
    expect(missingAccount.status).toBe(400)
  })

  it("forwards status and sync routes to the real IMAP Durable Object", async () => {
    const accountId = `runtime-${crypto.randomUUID()}`
    const status = await worker.fetch(new Request(
      `https://worker.test/imap/status?accountId=${encodeURIComponent(accountId)}`,
    ))
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({ status: "stopped" })

    const sync = await worker.fetch(new Request(
      `https://worker.test/imap/sync?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST" },
    ))
    expect(sync.status).toBe(200)
    await expect(sync.json()).resolves.toEqual({ ok: true })
  })

  it("persists and clears state through the real IMAP Durable Object", async () => {
    const accountId = `runtime-${crypto.randomUUID()}`
    const start = await worker.fetch(new Request(
      `https://worker.test/imap/start?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST" },
    ))
    expect(start.status).toBe(200)

    const id = runtimeEnv.IMAP_POLLER.idFromName(accountId)
    const stub = runtimeEnv.IMAP_POLLER.get(id)
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.get("accountId")).resolves.toBe(accountId)
      await expect(state.storage.getAlarm()).resolves.not.toBeNull()
    })

    const stop = await worker.fetch(new Request(
      `https://worker.test/imap/stop?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST" },
    ))
    expect(stop.status).toBe(200)

    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.get("accountId")).resolves.toBeUndefined()
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
