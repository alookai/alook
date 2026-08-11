import { describe, expect, it, vi } from "vitest"
import { WS_EVENTS } from "@alook/shared"
import { communityWsEventFixtures } from "../../../../../shared/test/community-ws-events.fixtures"
import {
  communityWsReconnectPolicies,
  communityWsRegistry,
  dispatchCommunityWsEvent,
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
    expect(communityWsReconnectPolicies).toHaveLength(12)
    expect(new Set(communityWsReconnectPolicies).size).toBe(12)
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
    const context = { marker: "context" } as never
    dispatchCommunityWsEvent(communityWsEventFixtures[type], context)
    expect(handlers[handlerName]).toHaveBeenCalled()
  })
})
