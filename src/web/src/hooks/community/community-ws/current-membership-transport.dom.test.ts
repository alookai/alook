import { messageProfilesFixture } from "@/test/community-resource-fixtures"
/// <reference types="../../../../../ws-do/src/env" />
import { resetCommunityWsHarness, cleanupCommunityWsHarness, mountHook, seedCanonicalThread, capturedOnMessage,
  canonicalRegistry, canonicalMessage, hasCanonicalChannelNotify } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_DELIVERY_OPERATION_ID_HEADER, createLogger, decodeCommunityBrowserEvent, encodeCommunityBrowserEvent,
  deriveCommunityDeliveryOperationId, encodePreparedCommunityBrowserEventBatch, serializeMessageDeliveryBatch, type MessageDeliveryBatch } from "@alook/shared"
import { handleMessageDelivery } from "../../../../../ws-do/src/routes/message-delivery"
import { readCommunityBrowserEventBundleRequest } from "../../../../../ws-do/src/community-browser-event-ingress"
import { createCommunityDeliveryReceipt } from "../../../../../ws-do/src/community-delivery-receipt"
import { messageResourceFixture } from "@/test/community-resource-fixtures"
import { act } from "@/test/react-dom-harness"
import * as registry from "./registry"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

const batch = (): MessageDeliveryBatch => ({ communityContract: BUSINESS_SCHEMA_VERSION, messageId: "message-current-join",
  messageEvent: { profiles: messageProfilesFixture([{ ...messageResourceFixture({ id: "message-current-join", channelId: "thread-current", authorId: "author-current" }), authorName: "Author", authorAvatarVersion: 1 }]), type: "community:message.create", channelId: "thread-current", serverId: "server-current", parentChannelId: "parent-current",
    message: { ...messageResourceFixture({ id: "message-current-join", channelId: "thread-current", authorId: "author-current" }), authorName: "Author", authorAvatarVersion: 1 } },
  contentUserIds: ["u_me"], unreadPlainUserIds: [], unreadMentionUserIds: [], mentionUserIds: [],
  joinedParticipantUserIds: ["u_me"], rosterRefreshUserId: "u_me",
})

async function deliver(value: unknown, apply = true) {
  const calls: unknown[] = []
  const fetch = vi.fn(async (request: Request) => {
    const ingress = await readCommunityBrowserEventBundleRequest(request)
    if (!ingress.ok) throw new Error("Current target ingress rejected")
    calls.push(...ingress.prepared.events)
    const encoded = encodePreparedCommunityBrowserEventBatch({ operationId: ingress.operationId, operationDigest: ingress.operationDigest, prepared: ingress.prepared })
    if (!encoded.ok) throw new Error("Current browser batch rejected")
    if (apply) await capturedOnMessage!(encoded.batch)
    return Response.json(createCommunityDeliveryReceipt({ status: "complete", operationId: ingress.operationId,
      operationDigest: ingress.operationDigest, eventCount: ingress.eventCount,
      results: [{ socketIndex: 0, outcome: "enqueued", frameCount: 1, persistedNextFrameIndex: 1, ambiguousClosed: false }] }))
  })
  const request = new Request("https://ws.test/broadcast/community/message-delivery", { method: "POST",
    headers: { "content-type": "application/json", [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: await deriveCommunityDeliveryOperationId(batch().messageId) },
    body: JSON.stringify(value) })
  const context = { request, url: new URL(request.url), traceId: undefined, log: createLogger({ service: "current-membership-test" }),
    env: { WS_DO: { idFromName: (name: string) => name, get: () => ({ fetch }) } } } as unknown as Parameters<typeof handleMessageDelivery>[0]
  const response = await handleMessageDelivery(context)
  return { response, calls, fetch }
}

describe("current membership producer to consumer", () => {
  it("delivers committed participant notify membership through actual route, ingress and hook", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server-current", "parent-current", "text", "thread-current")
    const value = JSON.parse(serializeMessageDeliveryBatch(batch()))
    const result = await act(() => deliver(value))
    expect(result.response?.status).toBe(200)
    expect(result.calls).toContainEqual({ type: "community:channel.membership.change", channelId: "thread-current", serverId: "server-current", userId: "u_me", relation: "notify", present: true })
    expect(hasCanonicalChannelNotify("thread-current", "u_me")).toBe(true)
    expect(canonicalMessage(batch().messageId)?.content).toBe("Body")
  })

  it("calibrates the actual singular dispatch on a normal current single relationship frame", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server-current", "parent-current", "text", "thread-current")
    const encoded = encodeCommunityBrowserEvent({ type: "community:channel.membership.change", serverId: "server-current", channelId: "thread-current", userId: "u_me", relation: "notify", present: true })
    if (!encoded.ok) throw new Error("Current relationship fixture rejected")
    const dispatch = vi.spyOn(registry, "dispatchCommunityWsEvent")
    await act(async () => { await capturedOnMessage!(encoded.envelope) })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(hasCanonicalChannelNotify("thread-current", "u_me")).toBe(true)
  })

  it.each(["community:channel.member_add", "community:channel.member_remove"])("rejects obsolete %s even inside the current wire version before dispatch", async type => {
    await mountHook({ viewerUserId: "u_me" })
    const frame = { type, schemaVersion: BUSINESS_SCHEMA_VERSION, channelId: "thread-current", serverId: "server-current", userId: "peer" }
    const dispatch = vi.spyOn(registry, "dispatchCommunityWsEvent")
    const counts = () => [canonicalRegistry!.collections.channels.size, canonicalRegistry!.collections.channelMemberships.size, canonicalRegistry!.collections.messages.size]
    const before = counts()
    const decoded = decodeCommunityBrowserEvent(frame)
    await act(async () => { await capturedOnMessage!(frame) })
    expect({ admitted: decoded.ok, dispatched: dispatch.mock.calls.length }).toEqual({ admitted: false, dispatched: 0 })
    expect(counts()).toEqual(before)
  })

  it("rejects obsolete memberAdded before any target delivery", async () => {
    const result = await deliver({ ...batch(), memberAdded: { userId: "u_me", channelId: "thread-current", serverId: "server-current" } }, false)
    expect(result.response?.status).toBe(400)
    expect(result.fetch).not.toHaveBeenCalled()
  })
})
