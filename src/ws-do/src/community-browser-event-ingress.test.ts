import { describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_BULK_BODY_MAX_BYTES,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEvent,
  encodeCommunityUserTargetPathSegment,
  prepareCommunityDeliveryEvents,
  utf8ByteLength,
  type CommunityBotAuditEvent,
  type CommunityMessageCreate,
  type CommunityWsEvent,
} from "@alook/shared"
import {
  communityWsEventFixtures,
  requiredFixturePaths,
} from "../../shared/test/community-ws-events.fixtures"
import {
  decodeCommunityTargetPathSegment,
  logCommunityBrowserEventRejected,
  normalizeCommunityBrowserEvent,
  readBoundedJsonRequest,
  readCommunityBrowserEventBundleRequest,
  readCommunityBrowserEventRequest,
} from "./community-browser-event-ingress"

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function corruptRequiredField(event: CommunityWsEvent, path: readonly string[]) {
  const copy = clone(event) as unknown as Record<string, unknown>
  let target = copy
  for (const segment of path.slice(0, -1)) target = target[segment] as Record<string, unknown>
  delete target[path[path.length - 1]]
  return copy
}

function requestFromBytes(bytes: BodyInit, headers?: HeadersInit) {
  return new Request("http://internal/community", { method: "POST", headers, body: bytes })
}

function maximizePadding<T extends CommunityWsEvent>(build: (padding: string) => T) {
  let low = 0
  let high = COMMUNITY_BROWSER_EVENT_MAX_BYTES
  let best: ReturnType<typeof encodeCommunityBrowserEvent> | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const encoded = encodeCommunityBrowserEvent(build("x".repeat(mid)))
    if (encoded.ok) {
      best = encoded
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (!best?.ok) throw new Error("unable to construct boundary fixture")
  return best
}

function worstEscapingTarget(index: number) {
  const chars = Array.from({ length: 128 }, () => "\u0000")
  let cursor = index
  for (let offset = 1; offset <= 4; offset += 1) {
    chars[chars.length - offset] = String.fromCharCode(cursor % 8)
    cursor = Math.floor(cursor / 8)
  }
  return chars.join("")
}

describe("community browser event ingress", () => {
  it("normalizes all 41 current fixtures without a version field", () => {
    const fixtures = Object.values(communityWsEventFixtures)
    expect(fixtures).toHaveLength(41)
    for (const fixture of fixtures) {
      const normalized = normalizeCommunityBrowserEvent(fixture)
      expect(normalized).toMatchObject({ ok: true, event: fixture, envelope: fixture })
      if (!normalized.ok) continue
      expect(normalized.envelope).not.toHaveProperty("contractVersion")
      expect(JSON.parse(normalized.body)).toEqual(fixture)
    }
  })

  it("rejects every required-field corruption and representative invalid families", () => {
    for (const [type, fixture] of Object.entries(communityWsEventFixtures)) {
      expect(normalizeCommunityBrowserEvent(
        corruptRequiredField(fixture, requiredFixturePaths[type as CommunityWsEvent["type"]]),
      )).toMatchObject({ ok: false, reason: "invalid-payload" })
    }
    expect(normalizeCommunityBrowserEvent({ type: "task.updated" })).toMatchObject({ reason: "wrong-family" })
    expect(normalizeCommunityBrowserEvent({ type: "community:future" })).toMatchObject({ reason: "unknown-community-type" })
    expect(normalizeCommunityBrowserEvent({
      ...communityWsEventFixtures["community:presence.update"],
      contractVersion: 1,
    })).toMatchObject({ reason: "invalid-payload" })
  })

  it("rejects malformed UTF-8, malformed JSON, lying lengths, and streamed overflow", async () => {
    await expect(readCommunityBrowserEventRequest(requestFromBytes(new Uint8Array([0xc3, 0x28]))))
      .resolves.toMatchObject({ ok: false, reason: "invalid-json" })
    await expect(readCommunityBrowserEventRequest(requestFromBytes("{")))
      .resolves.toMatchObject({ ok: false, reason: "invalid-json" })
    await expect(readCommunityBrowserEventRequest(requestFromBytes("{}", { "content-length": "65537" })))
      .resolves.toMatchObject({ ok: false, reason: "oversized" })
    await expect(readCommunityBrowserEventRequest(requestFromBytes(
      "x".repeat(COMMUNITY_BROWSER_EVENT_MAX_BYTES + 1),
      { "content-length": "1" },
    ))).resolves.toMatchObject({ ok: false, reason: "oversized" })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"))
        controller.error(new Error("stream failed"))
      },
    })
    const failedStreamRequest = new Request("http://internal/community", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    await expect(readCommunityBrowserEventRequest(failedStreamRequest))
      .resolves.toMatchObject({ ok: false, reason: "invalid-json" })
  })

  it("accepts maximum legal message and audit bodies and rejects one byte past", async () => {
    const message = maximizePadding<CommunityMessageCreate>((padding) => ({
      ...communityWsEventFixtures["community:message.create"],
      message: {
        ...communityWsEventFixtures["community:message.create"].message,
        content: "m".repeat(4000),
        attachments: Array.from({ length: 10 }, (_, index) => ({
          id: `attachment-${index}`,
          filename: `file-${index}.txt`,
          url: `/attachment/${index}`,
          size: 25 * 1024 * 1024,
        })),
        embeds: [{ padding }],
      },
    }))
    const audit = maximizePadding<CommunityBotAuditEvent>((padding) => ({
      ...communityWsEventFixtures["community:bot.audit_event"],
      payload: { text: "t".repeat(4096), padding },
    }))
    expect(message.byteLength).toBe(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    expect(audit.byteLength).toBe(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    await expect(readCommunityBrowserEventRequest(requestFromBytes(message.body)))
      .resolves.toMatchObject({ ok: true, byteCount: COMMUNITY_BROWSER_EVENT_MAX_BYTES })
    await expect(readCommunityBrowserEventRequest(requestFromBytes(audit.body)))
      .resolves.toMatchObject({ ok: true, byteCount: COMMUNITY_BROWSER_EVENT_MAX_BYTES })
    await expect(readCommunityBrowserEventRequest(requestFromBytes(`${message.body} `)))
      .resolves.toMatchObject({ ok: false, reason: "oversized" })
  })

  it("strictly validates bundle operation metadata and independently recomputes its digest", async () => {
    const events = [
      communityWsEventFixtures["community:message.create"],
      communityWsEventFixtures["community:unread.bump"],
    ]
    const prepared = await prepareCommunityDeliveryEvents(events)
    if (!prepared.ok) throw new Error("bundle fixture must prepare")
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const body = {
      operationId,
      operationDigest: prepared.prepared.digest,
      events: prepared.prepared.envelopes,
    }
    await expect(readCommunityBrowserEventBundleRequest(requestFromBytes(JSON.stringify(body))))
      .resolves.toMatchObject({
        ok: true,
        operationId,
        operationDigest: prepared.prepared.digest,
        eventCount: 2,
      })
    for (const invalid of [
      { ...body, operationId: "message:short" },
      { ...body, operationDigest: "A".repeat(64) },
      { ...body, operationDigest: "0".repeat(64) },
      { ...body, events: [{ ...body.events[0], contractVersion: 1 }, ...body.events.slice(1)] },
      { ...body, events: [...body.events, { type: "community:future" }] },
      { ...body, extra: true },
    ]) {
      await expect(readCommunityBrowserEventBundleRequest(requestFromBytes(JSON.stringify(invalid))))
        .resolves.toMatchObject({ ok: false, reason: "invalid-payload" })
    }
  })

  it("locks target decoding and the exact worst-case strict bulk boundary", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    expect(decodeCommunityTargetPathSegment(encodeCommunityUserTargetPathSegment(uuid))).toEqual({ ok: true, target: uuid })
    expect(decodeCommunityTargetPathSegment(encodeCommunityUserTargetPathSegment("reserved /?# 用户"))).toEqual({
      ok: true,
      target: "reserved /?# 用户",
    })
    expect(decodeCommunityTargetPathSegment("u:%zz")).toMatchObject({ reason: "invalid-target" })
    expect(decodeCommunityTargetPathSegment("unframed")).toMatchObject({ reason: "invalid-target" })
    expect(decodeCommunityTargetPathSegment("")).toMatchObject({ reason: "invalid-target" })
    expect(decodeCommunityTargetPathSegment(encodeCommunityUserTargetPathSegment("x".repeat(129))))
      .toMatchObject({ reason: "invalid-target" })

    const event = maximizePadding<CommunityBotAuditEvent>((padding) => ({
      ...communityWsEventFixtures["community:bot.audit_event"],
      payload: { padding },
    }))
    const targets = Array.from({ length: 1000 }, (_, index) => worstEscapingTarget(index))
    const body = JSON.stringify({
      userIds: targets,
      message: event.event,
      excludeUserId: worstEscapingTarget(1000),
    })
    expect(utf8ByteLength(body)).toBe(COMMUNITY_BULK_BODY_MAX_BYTES)
    await expect(readBoundedJsonRequest(requestFromBytes(body), COMMUNITY_BULK_BODY_MAX_BYTES))
      .resolves.toMatchObject({ ok: true, byteCount: COMMUNITY_BULK_BODY_MAX_BYTES })
    await expect(readBoundedJsonRequest(requestFromBytes(`${body} `), COMMUNITY_BULK_BODY_MAX_BYTES))
      .resolves.toMatchObject({ ok: false, reason: "oversized" })
  })

  it("rejects oversize independently of type placement and logs only bounded metadata", async () => {
    for (const body of [
      JSON.stringify({ type: "community:presence.update", padding: "sentinel-token".repeat(5000) }),
      JSON.stringify({ padding: "sentinel-token".repeat(5000), type: "community:presence.update" }),
    ]) {
      const result = await readCommunityBrowserEventRequest(requestFromBytes(body))
      expect(result).toMatchObject({ ok: false, reason: "oversized" })
      if (result.ok) continue
      const warn = vi.fn()
      logCommunityBrowserEventRejected({ warn }, "strict-single", result, 1000)
      const serialized = JSON.stringify(warn.mock.calls)
      expect(serialized).not.toContain("sentinel-token")
      expect(serialized).toContain("community_browser_event_rejected")
      expect(serialized).toContain("oversized")
    }
  })
})
