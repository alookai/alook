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
  return useCommunityWsStore.getState().beginProfileSnapshot()
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

  it("fails closed until websocket authentication and advances access epochs", () => {
    expect(useCommunityWsStore.getState()).toMatchObject({ accessConnected: false, accessEpoch: 0 })
    useCommunityWsStore.getState().markAccessConnected()
    useCommunityWsStore.getState().markAccessDisconnected()
    expect(useCommunityWsStore.getState()).toMatchObject({ accessConnected: false, accessEpoch: 1 })
  })

  it("seeds eligible groups and preserves groups patched after request start", () => {
    const initial = activate()
    useCommunityWsStore.getState().seedProfiles(initial, [{
      id: "u1",
      identityAbout: { name: "API old", aboutMe: "api bio" },
      status: { statusEmoji: "🌱", statusText: "api" },
      presence: "offline",
    }])

    const request = useCommunityWsStore.getState().beginProfileSnapshot()
    useCommunityWsStore.getState().patchProfiles(request, [{
      id: "u1",
      identityAbout: { name: "WS new", aboutMe: undefined },
      presence: "online",
    }])
    useCommunityWsStore.getState().seedProfiles(request, [{
      id: "u1",
      identityAbout: { name: "late API", aboutMe: "late bio" },
      status: { statusEmoji: "🎧", statusText: "late status" },
      presence: "offline",
    }])

    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      name: "WS new",
      aboutMe: undefined,
      statusEmoji: "🎧",
      statusText: "late status",
      presence: "online",
    })
  })

  it("advances authoritative group revisions even when values are equal", () => {
    const initial = activate()
    useCommunityWsStore.getState().seedProfiles(initial, [{
      id: "u1",
      status: { statusEmoji: null, statusText: null },
    }])
    const request = useCommunityWsStore.getState().beginProfileSnapshot()
    useCommunityWsStore.getState().patchProfiles(request, [{
      id: "u1",
      status: { statusEmoji: null, statusText: null },
    }])
    const afterPatch = useCommunityWsStore.getState()
    expect(afterPatch.profileRevision).toBe(request.revision + 1)

    afterPatch.seedProfiles(request, [{
      id: "u1",
      status: { statusEmoji: "stale", statusText: "stale" },
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      statusEmoji: null,
      statusText: null,
    })
  })

  it("conditionally commits a successful mutation ahead of an older API seed", () => {
    const oldGet = activate()
    const mutation = useCommunityWsStore.getState().beginProfileSnapshot()

    useCommunityWsStore.getState().commitProfiles(mutation, [{
      id: "u1",
      identityAbout: { name: "Local mutation" },
    }])
    expect(useCommunityWsStore.getState().profileRevision).toBe(1)

    useCommunityWsStore.getState().seedProfiles(oldGet, [{
      id: "u1",
      identityAbout: { name: "Old GET" },
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")?.name)
      .toBe("Local mutation")
  })

  it("does not let a mutation response overwrite a newer WS group patch", () => {
    const mutation = activate()
    const profiles = useCommunityWsStore.getState()
    profiles.patchProfiles(profiles.beginProfileSnapshot(), [{
      id: "u1",
      identityAbout: { name: "Newer WS" },
    }])

    profiles.commitProfiles(mutation, [{
      id: "u1",
      identityAbout: { name: "Mutation response" },
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")?.name)
      .toBe("Newer WS")
    expect(useCommunityWsStore.getState().profileRevision).toBe(1)
  })

  it("compares avatar versions independently without advancing group revision", () => {
    const snapshot = activate()
    const store = useCommunityWsStore.getState()
    store.patchProfiles(snapshot, [{
      id: "u1",
      avatar: { avatar: "/a?v=2", avatarVersion: 2 },
    }])
    expect(useCommunityWsStore.getState().profileRevision).toBe(0)

    store.patchProfiles(snapshot, [{
      id: "u1",
      avatar: { avatar: "/stale?v=1", avatarVersion: 1 },
    }, {
      id: "u1",
      avatar: { avatar: "/conflict?v=2", avatarVersion: 2 },
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      avatar: "/a?v=2",
      avatarVersion: 2,
    })

    store.seedProfiles(snapshot, [{
      id: "u1",
      avatar: { avatar: "/a?v=3", avatarVersion: 3 },
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      avatar: "/a?v=3",
      avatarVersion: 3,
    })
  })

  it("rejects late work after viewer switch and prevents reset ABA", () => {
    const oldSnapshot = activate("viewer-a")
    useCommunityWsStore.getState().activateProfileAccount("viewer-b")
    expect(useCommunityWsStore.getState().seedProfiles(oldSnapshot, [{
      id: "u1",
      identityAbout: { name: "wrong viewer" },
    }])).toBe(false)

    const beforeReset = useCommunityWsStore.getState().beginProfileSnapshot()
    useCommunityWsStore.getState().reset()
    useCommunityWsStore.getState().activateProfileAccount("viewer-b")
    expect(useCommunityWsStore.getState().patchProfiles(beforeReset, [{
      id: "u1",
      identityAbout: { name: "ABA" },
    }])).toBe(false)
    expect(useCommunityWsStore.getState().profilesByUserId.size).toBe(0)
  })

  it("applies multiple same-user groups in one authoritative batch", () => {
    const snapshot = activate()
    useCommunityWsStore.getState().patchProfiles(snapshot, [{
      id: "u1",
      identityAbout: { name: "Alice" },
    }, {
      id: "u1",
      status: { statusEmoji: "🎧", statusText: "Focus" },
      presence: "online",
    }])
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      name: "Alice",
      statusEmoji: "🎧",
      statusText: "Focus",
      presence: "online",
    })
    expect(useCommunityWsStore.getState().profileRevisionsByUserId.get("u1"))
      .toEqual({ identityAbout: 1, status: 1, presence: 1 })
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
