import { describe, expect, it } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_BULK_BODY_MAX_BYTES,
  COMMUNITY_USER_TARGET_MAX_BYTES,
  CommunityWsEventSchema,
  WS_EVENTS,
  decodeCommunityBrowserEvent,
  encodeCommunityBrowserEvent,
  isCommunityEventCandidate,
  isCommunityEventType,
  isValidCommunityUserTarget,
  utf8ByteLength,
  type CommunityBotAuditEvent,
  type CommunityMessageCreate,
  type CommunityWsEvent,
} from "../src/community-ws-events"
import { communityWsEventFixtures, requiredFixturePaths } from "./community-ws-events.fixtures"

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withoutPath(event: CommunityWsEvent, path: readonly string[]): unknown {
  const copy = clone(event) as unknown as Record<string, unknown>
  let target = copy
  for (const segment of path.slice(0, -1)) target = target[segment] as Record<string, unknown>
  delete target[path[path.length - 1]]
  return copy
}

function maximizePadding<T extends CommunityWsEvent>(factory: (padding: string) => T): {
  event: T
  body: string
  byteLength: number
} {
  let low = 0
  let high = COMMUNITY_BROWSER_EVENT_MAX_BYTES
  let best: { event: T; body: string; byteLength: number } | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const encoded = encodeCommunityBrowserEvent(factory("x".repeat(mid)))
    if (encoded.ok) {
      best = { event: factory("x".repeat(mid)), body: encoded.body, byteLength: encoded.byteLength }
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (!best) throw new Error("fixture cannot fit")
  return best
}

function worstEscapingTarget(index: number): string {
  const chars = Array.from({ length: COMMUNITY_USER_TARGET_MAX_BYTES }, () => "\u0000")
  let cursor = index
  for (let offset = 1; offset <= 4; offset += 1) {
    chars[chars.length - offset] = String.fromCharCode(cursor % 8)
    cursor = Math.floor(cursor / 8)
  }
  return chars.join("")
}

describe("Community browser event runtime contract", () => {
  const fixtures = Object.values(communityWsEventFixtures)
  const names = Object.values(WS_EVENTS).sort()

  it("locks the exact 45-event inventory", () => {
    expect(names).toHaveLength(45)
    expect(Object.keys(communityWsEventFixtures).sort()).toEqual(names)
    expect(Object.keys(requiredFixturePaths).sort()).toEqual(names)
  })

  it("decodes and canonically encodes all 45 current event fixtures", () => {
    for (const fixture of fixtures) {
      expect(decodeCommunityBrowserEvent(fixture)).toEqual({ ok: true, event: fixture })
      const encoded = encodeCommunityBrowserEvent(fixture)
      expect(encoded.ok).toBe(true)
      if (!encoded.ok) continue
      expect(encoded.event).toEqual(fixture)
      expect(encoded.event).not.toHaveProperty("contractVersion")
      expect(JSON.parse(encoded.body)).toEqual(fixture)
      expect(decodeCommunityBrowserEvent(encoded.event)).toEqual({ ok: true, event: fixture })
    }
  })

  it("rejects one required-field corruption for every event", () => {
    for (const fixture of fixtures) {
      const corrupted = withoutPath(fixture, requiredFixturePaths[fixture.type])
      expect(decodeCommunityBrowserEvent(corrupted)).toMatchObject({
        ok: false,
        reason: "invalid-payload",
        type: fixture.type,
      })
    }
  })

  it("uses a bounded read-state dirty hint instead of an account-sized frame", () => {
    expect(decodeCommunityBrowserEvent({
      type: "community:read_state.advanced",
      revision: 4,
      inboxChanged: true,
    })).toMatchObject({ ok: true })
    expect(decodeCommunityBrowserEvent({
      type: "community:inbox.changed",
      revision: 5,
      inboxChanged: true,
      reason: "read_all",
    })).toMatchObject({ ok: true })

    const accountSizedFrame = {
      type: "community:read_state.advanced",
      revision: 4,
      readStates: Array.from({ length: 500 }, (_, index) => ({
        channelId: `channel-${index}-${"c".repeat(72)}`,
        lastReadMessageId: `message-${index}-${"m".repeat(72)}`,
        lastReadAt: "2026-08-24T00:00:00.000Z",
        lastReadSeq: index,
      })),
      inboxChanged: true,
    }
    expect(utf8ByteLength(JSON.stringify(accountSizedFrame)))
      .toBeGreaterThan(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    expect(decodeCommunityBrowserEvent(accountSizedFrame))
      .toMatchObject({ ok: false, reason: "invalid-payload" })
    const encodedHint = encodeCommunityBrowserEvent({
      type: "community:read_state.advanced",
      revision: 4,
      inboxChanged: true,
    })
    expect(encodedHint).toMatchObject({ ok: true })
    if (encodedHint.ok) expect(encodedHint.byteLength).toBeLessThan(128)
  })

  it("fails closed for family, removed-version, shape, and strict-key errors", () => {
    expect(decodeCommunityBrowserEvent(null)).toMatchObject({ reason: "non-object" })
    expect(decodeCommunityBrowserEvent([])).toMatchObject({ reason: "non-object" })
    expect(decodeCommunityBrowserEvent({})).toMatchObject({ reason: "missing-type" })
    expect(decodeCommunityBrowserEvent({ type: "task.messages" })).toMatchObject({ reason: "wrong-family" })
    expect(decodeCommunityBrowserEvent({ type: "community:future" })).toMatchObject({ reason: "unknown-community-type" })
    expect(decodeCommunityBrowserEvent({ ...fixtures[0], contractVersion: 1 }))
      .toMatchObject({ reason: "invalid-payload" })
    expect(encodeCommunityBrowserEvent({ ...fixtures[0], contractVersion: 1 }))
      .toMatchObject({ ok: false, reason: "invalid-payload" })
    expect(decodeCommunityBrowserEvent({ ...fixtures[0], contractVersion: 2 }))
      .toMatchObject({ reason: "invalid-payload" })
    expect(decodeCommunityBrowserEvent({ ...fixtures[0], extra: true })).toMatchObject({ reason: "invalid-payload" })
    const nestedExtra = clone(communityWsEventFixtures["community:message.create"]) as CommunityMessageCreate & {
      message: CommunityMessageCreate["message"] & { extra: boolean }
    }
    nestedExtra.message.extra = true
    expect(decodeCommunityBrowserEvent(nestedExtra)).toMatchObject({ reason: "invalid-payload" })
    expect(decodeCommunityBrowserEvent({
      type: "community:message.edited",
      channelId: "child",
      messageId: "message",
      content: "title",
      parentChannelId: "forum",
    })).toMatchObject({ reason: "invalid-payload" })
  })

  it("keeps exact and candidate guards distinct", () => {
    expect(isCommunityEventType("community:message.create")).toBe(true)
    expect(isCommunityEventType("community:future")).toBe(false)
    expect(isCommunityEventCandidate({ type: "community:future" })).toBe(true)
    expect(isCommunityEventCandidate({ type: "task.messages" })).toBe(false)
  })

  it("accepts the fattest legal message and audit fixtures without truncation", () => {
    const message = maximizePadding<CommunityMessageCreate>((padding) => ({
      ...communityWsEventFixtures["community:message.create"],
      message: {
        ...communityWsEventFixtures["community:message.create"].message,
        content: "m".repeat(4000),
        attachments: Array.from({ length: 10 }, (_, index) => ({
          id: `attachment-${index}`,
          filename: `file-${index}.txt`,
          url: `/api/community/channels/channel-1/attachments/attachment-${index}`,
          contentType: "text/plain",
          size: 25 * 1024 * 1024,
        })),
        embeds: [{ padding }],
      },
    }))
    const audit = maximizePadding<CommunityBotAuditEvent>((padding) => ({
      ...communityWsEventFixtures["community:bot.audit_event"],
      kind: "thinking",
      payload: { text: "t".repeat(4096), padding },
    }))
    expect(message.byteLength).toBe(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    expect(audit.byteLength).toBe(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    expect(JSON.parse(message.body).message.content).toHaveLength(4000)
    expect(JSON.parse(message.body).message.attachments).toHaveLength(10)
    expect(CommunityWsEventSchema.safeParse(message.event).success).toBe(true)
    expect(CommunityWsEventSchema.safeParse(audit.event).success).toBe(true)
    expect(encodeCommunityBrowserEvent({
      ...message.event,
      message: { ...message.event.message, embeds: [{ padding: `${(message.event.message.embeds?.[0] as { padding: string }).padding}x` }] },
    })).toMatchObject({ ok: false, reason: "oversized", byteLength: COMMUNITY_BROWSER_EVENT_MAX_BYTES + 1 })
  })

  it("locks UTF-8 target boundaries and the strict bulk formula", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    expect(isValidCommunityUserTarget("a".repeat(32))).toBe(true)
    expect(isValidCommunityUserTarget(uuid)).toBe(true)
    expect(isValidCommunityUserTarget("é".repeat(64))).toBe(true)
    expect(isValidCommunityUserTarget("é".repeat(64) + "a")).toBe(false)
    expect(isValidCommunityUserTarget("")).toBe(false)
    expect(isValidCommunityUserTarget("a".repeat(128))).toBe(true)
    expect(isValidCommunityUserTarget("a".repeat(129))).toBe(false)
    expect(isValidCommunityUserTarget("\ud800")).toBe(false)
    expect(isValidCommunityUserTarget("\udfff")).toBe(false)
    expect(isValidCommunityUserTarget("\ud83d\ude00")).toBe(true)

    const targets = Array.from({ length: 1000 }, (_, index) => worstEscapingTarget(index))
    expect(new Set(targets).size).toBe(1000)
    expect(targets.every((target) => utf8ByteLength(target) === 128)).toBe(true)
    expect(targets.every((target) => utf8ByteLength(JSON.stringify(target)) === 770)).toBe(true)
    const emptyEventBody = JSON.stringify({
      userIds: targets,
      message: {},
      excludeUserId: worstEscapingTarget(1000),
    })
    expect(utf8ByteLength(emptyEventBody)).toBe(771_813)
    expect(utf8ByteLength(emptyEventBody) + COMMUNITY_BROWSER_EVENT_MAX_BYTES - 2)
      .toBe(COMMUNITY_BULK_BODY_MAX_BYTES)
  })
})
