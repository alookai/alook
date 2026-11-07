import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestMessages } from "@/lib/community-db/sync"
import { messageSeedFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { describe, expect, it, vi } from "vitest"
import { notifyManager, QueryClient } from "@tanstack/react-query"
import { WS_EVENTS } from "@alook/shared"
import { communityWsEventFixtures } from "../../../../../shared/test/community-ws-events.fixtures"
import type {
  CommunityWsDispatchContext,
  CommunityWsHandlerContext,
} from "./handler-context"
import {
  communityWsReconnectPolicies,
  communityWsRegistry,
  dispatchCommunityWsEvent,
  dispatchCommunityWsEvents,
} from "./registry"

const handlers = vi.hoisted(() => new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
  get(target, property: string) {
    target[property] ??= vi.fn()
    return target[property]
  },
}))

vi.mock("./pii-events", () => ({ handleBotPii: handlers.handleBotPii }))

vi.mock("./server-rail-reconciliation", () => ({ handleServerRailChanged: handlers.handleServerRailChanged }))

vi.mock("./message-events", () => ({
  handleMessageCreate: handlers.handleMessageCreate,
  handleMessageUpdated: handlers.handleMessageUpdated,
  handlePinEvent: handlers.handlePinEvent,
}))
vi.mock("./typing-events", () => ({
  handleTypingStart: handlers.handleTypingStart,
  handleTypingStop: handlers.handleTypingStop,
}))
vi.mock("./structure-tree-events", () => ({
  handleCategoryEvent: handlers.handleCategoryEvent,
  handleChannelEvent: handlers.handleChannelEvent,
  handleChildChannelCreate: handlers.handleChildChannelCreate,
  handleChildChannelUpdate: handlers.handleChildChannelUpdate,
  handleInviteCreate: handlers.handleInviteCreate,
  handleServerDelete: handlers.handleServerDelete,
  handleServerUpdate: handlers.handleServerUpdate,
}))
vi.mock("./membership-events", () => ({
  handleChannelMembershipChange: handlers.handleChannelMembershipChange,
  handleChannelMemberEvent: handlers.handleChannelMemberEvent,
  handleMemberJoin: handlers.handleMemberJoin,
  handleMemberLeave: handlers.handleMemberLeave,
  handleMemberUpdate: handlers.handleMemberUpdate,
}))
vi.mock("./social-events", () => ({
  handleFriendEvent: handlers.handleFriendEvent,
  handleInboxChanged: handlers.handleInboxChanged,
  handleMentionCreate: handlers.handleMentionCreate,
  handleReadStateAdvanced: handlers.handleReadStateAdvanced,
  handleUnreadBump: handlers.handleUnreadBump,
}))
vi.mock("./presence-machine-events", () => ({
  handleBotAuditEvent: handlers.handleBotAuditEvent,
  handleMachineCreated: handlers.handleMachineCreated,
  handleMachineRemoved: handlers.handleMachineRemoved,
  handleMachineStatus: handlers.handleMachineStatus,
  handleMachineUpdated: handlers.handleMachineUpdated,
  handlePresenceUpdate: handlers.handlePresenceUpdate,
  handleRuntimeModels: handlers.handleRuntimeModels,
}))
function dispatchContext(queryClient = new QueryClient()): CommunityWsDispatchContext {
  const runtime = createCommunityDbRegistry(queryClient, "u1").runtime
  return {
    deliveryMode: "single",
    queryClient,
    communityStore: runtime.ui,
    wsStore: runtime.ws,
    sub: {},
    viewerUserIdRef: { current: null },
    matchesFocus: () => false,

  }
}

describe("community WebSocket registry", () => {
  it("has exactly one entry for each runtime event type", () => {
    const eventTypes = Object.values(WS_EVENTS).sort()
    const registryTypes = Object.keys(communityWsRegistry).sort()
    expect(eventTypes).toHaveLength(46)
    expect(eventTypes).not.toContain("community:channel.member_add")
    expect(eventTypes).not.toContain("community:channel.member_remove")
    expect(registryTypes).toEqual(eventTypes)
  })

  it("assigns at least one reconnect policy to every event", () => {
    for (const entry of Object.values(communityWsRegistry)) {
      expect(entry.reconnectPolicies.length).toBeGreaterThan(0)
    }
  })

  it("deduplicates the complete policy set", () => {
    expect(communityWsReconnectPolicies).toHaveLength(15)
    expect(new Set(communityWsReconnectPolicies).size).toBe(15)
  })

  it.each([
    "community:server.update",
    "community:category.update",
    "community:channel.update",
    "community:channel.membership.change",
    "community:member.update",
    "community:unread.bump",
    "community:presence.update",
    "community:invite.create",
  ] as const)("assigns %s to all-cached-server reconciliation", (type) => {
    expect(communityWsRegistry[type].reconnectPolicies).toContain("all-cached-servers")
  })

  it.each([
    "community:friend.request",
    "community:friend.accept",
    "community:friend.reject",
    "community:friend.remove",
    "community:friend.block",
  ] as const)("assigns %s to Friends and Inbox reconnect reconciliation", (type) => {
    expect(communityWsRegistry[type].reconnectPolicies).toEqual(["friends", "inbox-dms"])
  })

  it.each([
    ["community:message.create", "handleMessageCreate"],
    ["community:typing.start", "handleTypingStart"],
    ["community:server.update", "handleServerUpdate"],
    ["community:server_rail.changed", "handleServerRailChanged"],
    ["community:member.join", "handleMemberJoin"],
    ["community:friend.accept", "handleFriendEvent"],
    ["community:presence.update", "handlePresenceUpdate"],
    ["community:machine.created", "handleMachineCreated"],
    ["community:runtime.models", "handleRuntimeModels"],
    ["community:bot.pii", "handleBotPii"],
    ["community:bot.audit_event", "handleBotAuditEvent"],
  ] as const)("dispatches %s through its existing handler group", (type, handlerName) => {
    const context = dispatchContext()
    dispatchCommunityWsEvent(communityWsEventFixtures[type], context)
    expect(handlers[handlerName]).toHaveBeenCalled()
  })

  it.each(["single", "batch"] as const)("projects canonical-only events through %s dispatch", async (mode) => {
    const { client, registry, runtime } = await createCommunityQueryOwner("viewer")
    const unregister = registerCommunityDbRegistry(registry)
    try {
      ingestMessages(registry, "channel-1", messageSeedFixture("channel-1", [{ id: "message-1", type: "chat", authorId: "user-1", authorName: "Before", content: "hello", reactions: [] }]))
      const context: CommunityWsDispatchContext = { queryClient: client, communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: "viewer" }, matchesFocus: () => false, deliveryMode: mode }
      const dispatch = async (events: typeof communityWsEventFixtures[keyof typeof communityWsEventFixtures][]) => {
        if (mode === "batch") await dispatchCommunityWsEvents(events, context)
        else for (const event of events) await dispatchCommunityWsEvent(event, context)
      }
      await dispatch([communityWsEventFixtures["community:reaction.add"]])
      expect(registry.collections.messages.get("message-1")?.reactions).toMatchObject([{ emoji: "👍", count: 1, me: false, userIds: ["user-1"] }])
      await dispatch([communityWsEventFixtures["community:profile.update"], { ...communityWsEventFixtures["community:status.update"], statusEmoji: "🌱", statusText: "Growing" }, communityWsEventFixtures["community:identity.update"]])
      expect(registry.collections.profiles.get("user-1")).toMatchObject({ name: "Alice", discriminator: "0042", aboutMe: "Hello", statusEmoji: "🌱", statusText: "Growing", avatar: "/api/community/users/user-1/avatar?v=2", avatarVersion: 2 })
      await dispatch([communityWsEventFixtures["community:reaction.remove"]])
      expect(registry.collections.messages.get("message-1")?.reactions).toEqual([])
    } finally { unregister() }
  })

  it("provides projection transactions to context-owning handlers", () => {
    dispatchCommunityWsEvent(
      communityWsEventFixtures["community:message.create"],
      dispatchContext(),
    )

    expect(handlers.handleMessageCreate).toHaveBeenCalledWith(
      communityWsEventFixtures["community:message.create"],
      expect.objectContaining({
        projection: expect.objectContaining({
          project: expect.any(Function),
          invalidate: expect.any(Function),
        }),
      }),
    )
  })

  it("wraps public single-event dispatch in one projection batch", () => {
    const batch = vi.spyOn(notifyManager, "batch")

    try {
      dispatchCommunityWsEvent(
        communityWsEventFixtures["community:typing.stop"],
        dispatchContext(),
      )
      expect(batch).toHaveBeenCalledTimes(1)
    } finally {
      batch.mockRestore()
    }
  })

  it("wraps a multi-event delivery in exactly one projection batch", () => {
    const batch = vi.spyOn(notifyManager, "batch")
    try {
      dispatchCommunityWsEvents([
        communityWsEventFixtures["community:typing.start"],
        communityWsEventFixtures["community:typing.stop"],
      ], dispatchContext())
      expect(batch).toHaveBeenCalledTimes(1)
    } finally {
      batch.mockRestore()
    }
  })

  it("lets later events observe synchronous projections from earlier events", () => {
    const queryClient = new QueryClient()
    const observed: number[] = []
    handlers.handleMessageCreate.mockImplementationOnce((
      _event: unknown,
      context: CommunityWsHandlerContext,
    ) => {
      context.projection.project(() => queryClient.setQueryData(["ordered"], 1))
    })
    handlers.handleTypingStart.mockImplementationOnce(() => {
      observed.push(queryClient.getQueryData<number>(["ordered"]) ?? 0)
    })

    dispatchCommunityWsEvents([
      communityWsEventFixtures["community:message.create"],
      communityWsEventFixtures["community:typing.start"],
    ], dispatchContext(queryClient))

    expect(observed).toEqual([1])
  })

  it("exposes the complete message only to a bump in the same unambiguous bundle", () => {
    handlers.handleUnreadBump.mockClear()
    const create = communityWsEventFixtures["community:message.create"]
    const bump = communityWsEventFixtures["community:unread.bump"]

    dispatchCommunityWsEvents([create, bump], dispatchContext())
    const pairedContext = handlers.handleUnreadBump.mock.calls[0]?.[1] as CommunityWsHandlerContext
    expect(pairedContext.unreadBumpEvidence?.get(bump)).toEqual({
      messageId: create.message.id,
      seq: create.message.seq,
      createdAt: create.message.createdAt,
      messageEvent: create,
    })

    handlers.handleUnreadBump.mockClear()
    dispatchCommunityWsEvents([create, { ...create, message: { ...create.message, id: "message-2" } }, bump], dispatchContext())
    const ambiguousContext = handlers.handleUnreadBump.mock.calls[0]?.[1] as CommunityWsHandlerContext
    expect(ambiguousContext.unreadBumpEvidence?.get(bump)).toBeUndefined()
  })
})
