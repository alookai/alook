import { beforeEach, describe, expect, it } from "vitest"
import {
  BOT_AUDIT_RING_MAX,
  SEEN_DELIVERY_OPERATION_MAX,
  SEEN_DELIVERY_OPERATION_TRIM_TO,
  SEEN_MESSAGE_MAX,
  SEEN_MESSAGE_TRIM_TO,
  useCommunityWsStore,
} from "./ws"

beforeEach(() => {
  useCommunityWsStore.getState().reset()
})

function activate(viewerId = "viewer") {
  useCommunityWsStore.getState().activateProfileAccount(viewerId)
  return useCommunityWsStore.getState().beginPresenceSnapshot()
}

describe("useCommunityWsStore", () => {
  it("publishes connection status, binds retry, and resets both safely", () => {
    const calls: string[] = []
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    useCommunityWsStore.getState().bindReconnectNow(() => calls.push("retry"))
    useCommunityWsStore.getState().reconnectNow()
    expect(calls).toEqual(["retry"])

    useCommunityWsStore.getState().reset()
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")
    useCommunityWsStore.getState().reconnectNow()
    expect(calls).toEqual(["retry"])
  })

  it("tracks websocket authentication without treating transport loss as revocation", () => {
    expect(useCommunityWsStore.getState()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
    useCommunityWsStore.getState().markAccessDisconnected()
    expect(useCommunityWsStore.getState()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
    useCommunityWsStore.getState().markAccessConnected()
    useCommunityWsStore.getState().markAccessDisconnected()
    useCommunityWsStore.getState().markAccessDisconnected()
    expect(useCommunityWsStore.getState()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
  })

  it("keeps only presence in the websocket overlay", () => {
    activate()
    useCommunityWsStore.getState().setPresence("u1", "online")
    expect(useCommunityWsStore.getState().presenceByUserId).toEqual(
      new Map([["u1", "online"]]),
    )
    expect(useCommunityWsStore.getState()).not.toHaveProperty("profilesByUserId")
  })

  it("preserves a live presence delta over an older HTTP seed", () => {
    const request = activate()
    useCommunityWsStore.getState().setPresence("u1", "online")
    useCommunityWsStore.getState().seedPresence(request, [["u1", "offline"]])
    expect(useCommunityWsStore.getState().presenceByUserId.get("u1")).toBe("online")
  })

  it("rejects a presence seed after viewer switch or reset", () => {
    const oldSnapshot = activate("viewer-a")
    useCommunityWsStore.getState().activateProfileAccount("viewer-b")
    expect(useCommunityWsStore.getState().seedPresence(oldSnapshot, [["u1", "online"]]))
      .toBe(false)
    const beforeReset = useCommunityWsStore.getState().beginPresenceSnapshot()
    useCommunityWsStore.getState().reset()
    useCommunityWsStore.getState().activateProfileAccount("viewer-b")
    expect(useCommunityWsStore.getState().seedPresence(beforeReset, [["u1", "online"]]))
      .toBe(false)
    expect(useCommunityWsStore.getState().presenceByUserId.size).toBe(0)
  })

  it("deduplicates seen messages and trims the oldest ids", () => {
    useCommunityWsStore.getState().markSeenMessage("m1")
    const first = useCommunityWsStore.getState().seenMessageIds
    useCommunityWsStore.getState().markSeenMessage("m1")
    expect(useCommunityWsStore.getState().seenMessageIds).toBe(first)

    for (let index = 2; index <= SEEN_MESSAGE_MAX + 1; index += 1) {
      useCommunityWsStore.getState().markSeenMessage(`m${index}`)
    }
    const after = useCommunityWsStore.getState().seenMessageIds
    expect(after.size).toBe(SEEN_MESSAGE_TRIM_TO)
    expect(after.has("m1")).toBe(false)
    expect(after.has(`m${SEEN_MESSAGE_MAX + 1}`)).toBe(true)
  })

  it("locks delivery digests and keeps same-digest failures retryable", () => {
    const digest = "a".repeat(64)
    expect(useCommunityWsStore.getState().observeDeliveryOperation("op", digest)).toBe("new")
    expect(useCommunityWsStore.getState().observeDeliveryOperation("op", digest)).toBe("retryable")
    expect(useCommunityWsStore.getState().observeDeliveryOperation("op", "b".repeat(64)))
      .toBe("conflict")
    expect(useCommunityWsStore.getState().completeDeliveryOperation("op", digest)).toBe(true)
    expect(useCommunityWsStore.getState().observeDeliveryOperation("op", digest)).toBe("duplicate")
  })

  it("bounds delivery operations and clears transient state on reset", () => {
    for (let index = 0; index <= SEEN_DELIVERY_OPERATION_MAX; index += 1) {
      const digest = index.toString(16).padStart(64, "0")
      useCommunityWsStore.getState().observeDeliveryOperation(`op-${index}`, digest)
      if (index % 2 === 0) {
        useCommunityWsStore.getState().completeDeliveryOperation(`op-${index}`, digest)
      }
    }
    expect(useCommunityWsStore.getState().seenDeliveryOperations.size)
      .toBe(SEEN_DELIVERY_OPERATION_TRIM_TO)
    const accountEpoch = useCommunityWsStore.getState().profileAccountEpoch
    useCommunityWsStore.getState().reset()
    expect(useCommunityWsStore.getState()).toMatchObject({
      profileViewerId: null,
      profileAccountEpoch: accountEpoch + 1,
    })
    expect(useCommunityWsStore.getState().seenDeliveryOperations.size).toBe(0)
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(0)
  })

  it("prepends, deduplicates, and independently bounds bot audit rings", () => {
    const push = useCommunityWsStore.getState().pushBotAuditEvent
    for (let index = 0; index < BOT_AUDIT_RING_MAX + 5; index += 1) {
      push({
        id: `a${index}`,
        botId: "bot-a",
        kind: "tool_call",
        payload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    }
    push({
      id: "quiet",
      botId: "bot-b",
      kind: "nap",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    push({
      id: "quiet",
      botId: "bot-b",
      kind: "nap",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(useCommunityWsStore.getState().botAuditEvents.get("bot-a")).toHaveLength(
      BOT_AUDIT_RING_MAX,
    )
    expect(useCommunityWsStore.getState().botAuditEvents.get("bot-b")).toHaveLength(1)
  })
})
