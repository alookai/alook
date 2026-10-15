import { getCapturedRuntime } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMessageCreate, CommunityTypingStart } from "@alook/shared"
import { act } from "@/test/react-dom-harness"
import { applyTypingIndicator } from "./typing"
import { communityKeys } from "@/lib/query-keys"
import { getCanonicalCommunityTypingMembership } from "@/lib/community-db/sync"
import { useTypingNamesForScope, useTypingUsersForScope } from "@/stores/community"
import {
  capturedOnMessage,
  capturedQueryClient,
  hasCanonicalChannel,
  hasCanonicalChannelAccess,
  cleanupCommunityWsHarness,
  mountHook,
  mountCanonicalHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  seedCanonicalThread,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — typing follows membership", () => {
  it.each(["text", "forum"] as const)("clears a departed %s child participant and timer, denies a repeated start, and permits rejoin", async (parentType) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("s1", "parent", parentType, "child")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "child" })
    await mountHook({ viewerUserId: "u_me" })
    const display = await mountCanonicalHook(() => ({ users: useTypingUsersForScope("ch:child"), names: useTypingNamesForScope("ch:child") }))
    const membership = { type: "community:channel.membership.change", serverId: "s1", channelId: "child", userId: "u_other", relation: "notify", present: true }
    capturedOnMessage!(membership)
    capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_other", name: "Other" })
    capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_kept" })
    act(() => applyTypingIndicator(capturedQueryClient, "dm:dm_other", "u_other", null))
    const oldTimer = getCapturedRuntime().ui.get().typingTimers.get("ch:child|u_other")
    expect(oldTimer).toBeDefined()
    const clear = vi.spyOn(globalThis, "clearTimeout")
    try {
      capturedOnMessage!({ ...membership, present: false })
      expect(clear).toHaveBeenCalledWith(oldTimer)
      expect(getCapturedRuntime().ui.get().typingTimers.has("ch:child|u_other")).toBe(false)
      expect(getCapturedRuntime().ui.get().typingByScope.get("ch:child")).toEqual(new Map([["u_kept", null]]))
      expect(display.result.current).toEqual({ users: ["u_kept"], names: { u_kept: null } })
      expect(getCapturedRuntime().ui.get().typingByScope.get("dm:dm_other")).toEqual(new Map([["u_other", null]]))
      expect(hasCanonicalChannel("child")).toBe(true)
      expect(hasCanonicalChannelAccess("parent", "u_me")).toBe(true)
      expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child", "s1")).toBe(false)
      capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_other" })
      expect(getCapturedRuntime().ui.get().typingByScope.get("ch:child")?.has("u_other")).toBe(false)
      capturedQueryClient.setQueryData(communityKeys.channelMembers("child", "notify"), { serverId: "s1", relation: "notify", members: [] })
      capturedOnMessage!(membership)
      capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_other" })
      expect(getCanonicalCommunityTypingMembership(capturedQueryClient, "child", "u_other")).not.toBe(false)
      expect(getCapturedRuntime().ui.get().typingByScope.get("ch:child")?.get("u_other")).toBeNull()
      expect(getCapturedRuntime().ui.get().typingTimers.has("ch:child|u_other")).toBe(true)
    } finally {
      clear.mockRestore()
    }
  })

  it.each(["text", "forum"] as const)("removes access to a %s parent from the typer and its known child without changing another scope", async (parentType) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("s1", "parent", parentType, "child")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "child" })
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_other" })
    act(() => {
      applyTypingIndicator(capturedQueryClient, "ch:parent", "u_other", null)
      applyTypingIndicator(capturedQueryClient, "dm:dm_other", "u_other", null)
    })
    capturedOnMessage!({ type: "community:channel.membership.change", serverId: "s1", channelId: "parent", userId: "u_other", relation: "access", present: false })
    expect(getCapturedRuntime().ui.get().typingByScope.has("ch:child")).toBe(false)
    expect(getCapturedRuntime().ui.get().typingByScope.has("ch:parent")).toBe(false)
    expect(getCapturedRuntime().ui.get().typingByScope.has("dm:dm_other")).toBe(true)
    capturedOnMessage!({ type: "community:typing.start", channelId: "child", userId: "u_other" })
    expect(getCapturedRuntime().ui.get().typingByScope.has("ch:child")).toBe(false)
  })

  it("denies a departed DM access member without changing channel typing or the viewer's reading", async () => {
    await mountHook({ viewerUserId: "u_me" })
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!({ type: "community:typing.start", channelId: "dm_1", userId: "u_peer" })
    act(() => applyTypingIndicator(capturedQueryClient, "ch:other", "u_peer", "Peer"))
    capturedOnMessage!({ type: "community:channel.membership.change", serverId: null, channelId: "dm_1", userId: "u_peer", relation: "access", present: false })
    expect(getCapturedRuntime().ui.get().typingByScope.has("dm:dm_1")).toBe(false)
    expect(getCapturedRuntime().ui.get().typingTimers.has("dm:dm_1|u_peer")).toBe(false)
    expect(getCapturedRuntime().ui.get().typingByScope.get("ch:other")?.get("u_peer")).toBe("Peer")
    capturedOnMessage!({ type: "community:typing.start", channelId: "dm_1", userId: "u_peer" })
    expect(getCapturedRuntime().ui.get().typingByScope.has("dm:dm_1")).toBe(false)
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("dm_1")).toBe(false)
  })
})

describe("useCommunityWs — typing.start honours focus (no DM leak)", () => {
  it("does NOT surface a DM-only typing.start when the viewer is focused on a channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "dm_other",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    // Focus is on ch_1, so the unfocused DM channel's typing.start is dropped
    // entirely — no scope gains a typer.
    const state = getCapturedRuntime().ui.get()
    expect(state.typingByScope.get("dm:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:ch_1")).toBeUndefined()
  })

  it("does surface a channel typing.start when the viewer is focused on that channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    expect([...(getCapturedRuntime().ui.get().typingByScope.get("ch:ch_1")?.keys() ?? [])]).toEqual([
      "u_other",
    ])
  })

  it("typing.stop clears the focused scope immediately", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
    })
    capturedOnMessage!({
      type: "community:typing.stop",
      channelId: "ch_1",
      userId: "u_other",
    })

    const state = getCapturedRuntime().ui.get()
    expect(state.typingByScope.get("ch:ch_1")).toBeUndefined()
    expect(state.typingTimers.has("ch:ch_1|u_other")).toBe(false)
  })

})
describe("useCommunityWs — typing state is scoped per conversation", () => {
  it("a DM typer lands only in the DM scope, never in a channel scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    // Viewer is focused on the DM when the peer starts typing.
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    // A DM is a channel — typing arrives as `typing.start` keyed by the DM's
    // channel id. The scope key resolves to `dm:` because the subscription's
    // `dmConversationId` slot holds that channel id.
    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "dm_1",
      userId: "u_peer",
    })

    const state = getCapturedRuntime().ui.get()
    // The typer is confined to dm:dm_1 — a channel view reading ch:* sees nothing.
    expect([...(state.typingByScope.get("dm:dm_1")?.keys() ?? [])]).toEqual(["u_peer"])
    expect(state.typingByScope.get("ch:dm_1")).toBeUndefined()
    // The 8s timer is keyed by (scope, user), not user alone.
    expect(state.typingTimers.has("dm:dm_1|u_peer")).toBe(true)
  })

  it("bot DM reply (message.create on a DM channel) clears the DM pill, in the dm: scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_bot" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    // Bot is "typing" in the DM (typing.start on the DM channel).
    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "dm_bot",
      userId: "u_bot",
    })
    expect([...(getCapturedRuntime().ui.get().typingByScope.get("dm:dm_bot")?.keys() ?? [])]).toEqual([
      "u_bot",
    ])

    // Its reply arrives as message.create on the same DM channel. The scope key
    // must resolve to dm:dm_bot (via the subscription), clearing the pill — not
    // leak into a ch: bucket.
    capturedOnMessage!({
      type: "community:message.create",
      channelId: "dm_bot",
      message: {
        id: "m_bot_reply",
        authorId: "u_bot",
        authorName: "bot",
        authorAvatarVersion: 0,
        content: "done",
        type: "chat",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    } as CommunityMessageCreate)

    const state = getCapturedRuntime().ui.get()
    expect(state.typingByScope.get("dm:dm_bot")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_bot")).toBeUndefined()
    expect(state.typingTimers.has("dm:dm_bot|u_bot")).toBe(false)
  })
})
