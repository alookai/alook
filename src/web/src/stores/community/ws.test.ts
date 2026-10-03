
import { createCommunityWsStore } from "./ws"
const nativeStore = createCommunityWsStore(null)
import { beforeEach, describe, expect, it } from "vitest"
import {
  SEEN_DELIVERY_OPERATION_MAX,
  SEEN_DELIVERY_OPERATION_TRIM_TO,
  SEEN_MESSAGE_MAX,
  SEEN_MESSAGE_TRIM_TO,
  useCommunityWsStore,
} from "./ws"

beforeEach(() => {
  nativeStore.actions.reset()
})

function activate(viewerId = "viewer") {
  nativeStore.actions.activateProfileAccount(viewerId)
  return nativeStore.actions.beginPresenceSnapshot()
}

describe("useCommunityWsStore", () => {
  it("publishes connection status, binds retry, and resets both safely", () => {
    const calls: string[] = []
    nativeStore.actions.setConnectionStatus("reconnecting")
    nativeStore.actions.bindReconnectNow(() => calls.push("retry"))
    nativeStore.get().reconnectNow()
    expect(calls).toEqual(["retry"])

    nativeStore.actions.reset()
    expect(nativeStore.get().connectionStatus).toBe("connected")
    nativeStore.get().reconnectNow()
    expect(calls).toEqual(["retry"])
  })

  it("tracks websocket authentication without treating transport loss as revocation", () => {
    expect(nativeStore.get()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
    nativeStore.actions.markAccessDisconnected()
    expect(nativeStore.get()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
    nativeStore.actions.markAccessConnected()
    nativeStore.actions.markAccessDisconnected()
    nativeStore.actions.markAccessDisconnected()
    expect(nativeStore.get()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
  })

  it("keeps only presence in the websocket overlay", () => {
    activate()
    nativeStore.actions.setPresence("u1", "online")
    expect(nativeStore.get().presenceByUserId).toEqual(
      new Map([["u1", "online"]]),
    )
    expect(nativeStore.get()).not.toHaveProperty("profilesByUserId")
  })

  it("preserves a live presence delta over an older HTTP seed", () => {
    const request = activate()
    nativeStore.actions.setPresence("u1", "online")
    nativeStore.actions.seedPresence(request, [["u1", "offline"]])
    expect(nativeStore.get().presenceByUserId.get("u1")).toBe("online")
  })

  it("rejects a presence seed after viewer switch or reset", () => {
    const oldSnapshot = activate("viewer-a")
    nativeStore.actions.activateProfileAccount("viewer-b")
    expect(nativeStore.actions.seedPresence(oldSnapshot, [["u1", "online"]]))
      .toBe(false)
    const beforeReset = nativeStore.actions.beginPresenceSnapshot()
    nativeStore.actions.reset()
    nativeStore.actions.activateProfileAccount("viewer-b")
    expect(nativeStore.actions.seedPresence(beforeReset, [["u1", "online"]]))
      .toBe(false)
    expect(nativeStore.get().presenceByUserId.size).toBe(0)
  })

  it("deduplicates seen messages and trims the oldest ids", () => {
    nativeStore.actions.markSeenMessage("m1")
    const first = nativeStore.get().seenMessageIds
    nativeStore.actions.markSeenMessage("m1")
    expect(nativeStore.get().seenMessageIds).toBe(first)

    for (let index = 2; index <= SEEN_MESSAGE_MAX + 1; index += 1) {
      nativeStore.actions.markSeenMessage(`m${index}`)
    }
    const after = nativeStore.get().seenMessageIds
    expect(after.size).toBe(SEEN_MESSAGE_TRIM_TO)
    expect(after.has("m1")).toBe(false)
    expect(after.has(`m${SEEN_MESSAGE_MAX + 1}`)).toBe(true)
  })

  it("locks delivery digests and keeps same-digest failures retryable", () => {
    const digest = "a".repeat(64)
    expect(nativeStore.actions.observeDeliveryOperation("op", digest)).toBe("new")
    expect(nativeStore.actions.observeDeliveryOperation("op", digest)).toBe("retryable")
    expect(nativeStore.actions.observeDeliveryOperation("op", "b".repeat(64)))
      .toBe("conflict")
    expect(nativeStore.actions.completeDeliveryOperation("op", digest)).toBe(true)
    expect(nativeStore.actions.observeDeliveryOperation("op", digest)).toBe("duplicate")
  })

  it("bounds delivery operations and clears transient state on reset", () => {
    for (let index = 0; index <= SEEN_DELIVERY_OPERATION_MAX; index += 1) {
      const digest = index.toString(16).padStart(64, "0")
      nativeStore.actions.observeDeliveryOperation(`op-${index}`, digest)
      if (index % 2 === 0) {
        nativeStore.actions.completeDeliveryOperation(`op-${index}`, digest)
      }
    }
    expect(nativeStore.get().seenDeliveryOperations.size)
      .toBe(SEEN_DELIVERY_OPERATION_TRIM_TO)
    const accountEpoch = nativeStore.get().profileAccountEpoch
    nativeStore.actions.reset()
    expect(nativeStore.get()).toMatchObject({
      profileViewerId: null,
      profileAccountEpoch: accountEpoch + 1,
    })
    expect(nativeStore.get().seenDeliveryOperations.size).toBe(0)
    expect(nativeStore.get().seenMessageIds.size).toBe(0)
  })

  it("keeps audit facts outside the transient owner", () => {
    expect(nativeStore.get()).not.toHaveProperty("botAuditEvents")
  })})
