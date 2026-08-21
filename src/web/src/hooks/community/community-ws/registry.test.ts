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

vi.mock("./message-events", () => ({
  handleMessageCreate: handlers.handleMessageCreate,
  handleMessageEdited: handlers.handleMessageEdited,
  handleMessageUpdated: handlers.handleMessageUpdated,
  handlePinEvent: handlers.handlePinEvent,
  handleReactionEvent: handlers.handleReactionEvent,
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
  handleChannelMemberEvent: handlers.handleChannelMemberEvent,
  handleMemberJoin: handlers.handleMemberJoin,
  handleMemberLeave: handlers.handleMemberLeave,
  handleMemberUpdate: handlers.handleMemberUpdate,
}))
vi.mock("./social-events", () => ({
  handleFriendEvent: handlers.handleFriendEvent,
  handleMentionCreate: handlers.handleMentionCreate,
  handleUnreadBump: handlers.handleUnreadBump,
}))
vi.mock("./presence-machine-events", () => ({
  handleBotAuditEvent: handlers.handleBotAuditEvent,
  handleMachineCreated: handlers.handleMachineCreated,
  handleMachineRemoved: handlers.handleMachineRemoved,
  handleMachineStatus: handlers.handleMachineStatus,
  handleMachineUpdated: handlers.handleMachineUpdated,
  handlePresenceUpdate: handlers.handlePresenceUpdate,
  handleStatusUpdate: handlers.handleStatusUpdate,
}))

function dispatchContext(queryClient = new QueryClient()): CommunityWsDispatchContext {
  return {
    deliveryMode: "legacy",
    queryClient,
    communityStore: {} as CommunityWsDispatchContext["communityStore"],
    wsStore: {} as CommunityWsDispatchContext["wsStore"],
    sub: {},
    viewerUserIdRef: { current: null },
    matchesFocus: () => false,
    scheduleInboxInvalidate: vi.fn(),
  }
}

describe("community WebSocket registry", () => {
  it("has exactly one entry for each of the 41 runtime event types", () => {
    const eventTypes = Object.values(WS_EVENTS).sort()
    const registryTypes = Object.keys(communityWsRegistry).sort()
    expect(eventTypes).toHaveLength(41)
    expect(registryTypes).toEqual(eventTypes)
  })

  it("assigns a handler and at least one reconnect policy to every event", () => {
    for (const entry of Object.values(communityWsRegistry)) {
      expect(entry.handler).toBeTypeOf("function")
      expect(entry.reconnectPolicies.length).toBeGreaterThan(0)
    }
  })

  it("deduplicates the complete policy set", () => {
    expect(communityWsReconnectPolicies).toHaveLength(13)
    expect(new Set(communityWsReconnectPolicies).size).toBe(13)
  })

  it.each([
    "community:server.update",
    "community:category.update",
    "community:channel.update",
    "community:channel.member_add",
    "community:member.update",
    "community:unread.bump",
    "community:presence.update",
    "community:invite.create",
  ] as const)("assigns %s to all-cached-server reconciliation", (type) => {
    expect(communityWsRegistry[type].reconnectPolicies).toContain("all-cached-servers")
  })

  it.each([
    ["community:message.create", "handleMessageCreate"],
    ["community:typing.start", "handleTypingStart"],
    ["community:server.update", "handleServerUpdate"],
    ["community:member.join", "handleMemberJoin"],
    ["community:friend.accept", "handleFriendEvent"],
    ["community:presence.update", "handlePresenceUpdate"],
    ["community:machine.created", "handleMachineCreated"],
    ["community:bot.audit_event", "handleBotAuditEvent"],
  ] as const)("dispatches %s through its existing handler group", (type, handlerName) => {
    const context = dispatchContext()
    dispatchCommunityWsEvent(communityWsEventFixtures[type], context)
    expect(handlers[handlerName]).toHaveBeenCalled()
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
})
