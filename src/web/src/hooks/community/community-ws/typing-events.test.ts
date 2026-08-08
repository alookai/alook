import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMessageCreate, CommunityTypingStart } from "@alook/shared"
import {
  capturedOnMessage,
  cleanupCommunityWsHarness,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — typing.start honours focus (no DM leak)", () => {
  it("does NOT surface a DM-only typing.start when the viewer is focused on a channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
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
    const state = useCommunityStore.getState()
    expect(state.typingByScope.get("dm:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:ch_1")).toBeUndefined()
  })

  it("does surface a channel typing.start when the viewer is focused on that channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    expect([...(useCommunityStore.getState().typingByScope.get("ch:ch_1")?.keys() ?? [])]).toEqual([
      "u_other",
    ])
  })

  it("typing.stop clears the focused scope immediately", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
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

    const state = useCommunityStore.getState()
    expect(state.typingByScope.get("ch:ch_1")).toBeUndefined()
    expect(state.typingTimers.has("ch:ch_1|u_other")).toBe(false)
  })

})
describe("useCommunityWs — typing state is scoped per conversation", () => {
  it("a DM typer lands only in the DM scope, never in a channel scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    // Viewer is focused on the DM when the peer starts typing.
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
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

    const state = useCommunityStore.getState()
    // The typer is confined to dm:dm_1 — a channel view reading ch:* sees nothing.
    expect([...(state.typingByScope.get("dm:dm_1")?.keys() ?? [])]).toEqual(["u_peer"])
    expect(state.typingByScope.get("ch:dm_1")).toBeUndefined()
    // The 8s timer is keyed by (scope, user), not user alone.
    expect(state.typingTimers.has("dm:dm_1|u_peer")).toBe(true)
  })

  it("bot DM reply (message.create on a DM channel) clears the DM pill, in the dm: scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_bot" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    // Bot is "typing" in the DM (typing.start on the DM channel).
    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "dm_bot",
      userId: "u_bot",
    })
    expect([...(useCommunityStore.getState().typingByScope.get("dm:dm_bot")?.keys() ?? [])]).toEqual([
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
        content: "done",
        type: "chat",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    } as CommunityMessageCreate)

    const state = useCommunityStore.getState()
    expect(state.typingByScope.get("dm:dm_bot")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_bot")).toBeUndefined()
    expect(state.typingTimers.has("dm:dm_bot|u_bot")).toBe(false)
  })
})
