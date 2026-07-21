import { describe, it, expect } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import type { Mention, UnreadDm, UnreadServer } from "@/components/community/_types"
import {
  inboxItemPresent,
  useInboxAutoCollapse,
  type InboxLists,
} from "./use-inbox-auto-collapse"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function server(serverId: string, channels: Array<{ id: string; children?: string[] }>): UnreadServer {
  return {
    serverId,
    serverName: serverId,
    channels: channels.map((c) => ({
      channelId: c.id,
      channelName: c.id,
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      mentionCount: 0,
      children: (c.children ?? []).map((chId) => ({
        channelId: chId,
        channelName: chId,
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        mentionCount: 0,
      })),
    })),
  }
}

function dm(id: string): UnreadDm {
  return {
    dmConversationId: id,
    otherUserId: `u-${id}`,
    otherUserName: id,
    otherUserAvatar: "?",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  }
}

function mention(id: string, channelId = "c1"): Mention {
  return {
    id,
    server: "s1",
    serverId: "s1",
    channel: channelId,
    channelId,
    m: { id: `msg-${id}`, authorId: "a", authorName: "A", authorAvatar: "?", content: "hi" } as Mention["m"],
  }
}

const EMPTY: InboxLists = { unreads: [], unreadDms: [], mentions: [] }

// ── inboxItemPresent (pure) ──────────────────────────────────────────────────

describe("inboxItemPresent", () => {
  it("finds a dm:<id> present in unreadDms; false when absent", () => {
    const lists: InboxLists = { ...EMPTY, unreadDms: [dm("d1")] }
    expect(inboxItemPresent(lists, "dm:d1")).toBe(true)
    expect(inboxItemPresent(lists, "dm:d2")).toBe(false)
  })

  it("finds a channel:<id> that is a top-level channel", () => {
    const lists: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])] }
    expect(inboxItemPresent(lists, "channel:c1")).toBe(true)
    expect(inboxItemPresent(lists, "channel:c2")).toBe(false)
  })

  it("finds a channel:<id> that is a nested child (thread / forum-post)", () => {
    const lists: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1", children: ["t1"] }])] }
    expect(inboxItemPresent(lists, "channel:t1")).toBe(true)
  })

  it("finds a mention:<id> present in mentions; false when absent", () => {
    const lists: InboxLists = { ...EMPTY, mentions: [mention("m1")] }
    expect(inboxItemPresent(lists, "mention:m1")).toBe(true)
    expect(inboxItemPresent(lists, "mention:m2")).toBe(false)
  })

  it("returns false for an unknown / garbage key", () => {
    const lists: InboxLists = { unreads: [server("s1", [{ id: "c1" }])], unreadDms: [dm("d1")], mentions: [mention("m1")] }
    expect(inboxItemPresent(lists, "bogus")).toBe(false)
    expect(inboxItemPresent(lists, "")).toBe(false)
    expect(inboxItemPresent(lists, "widget:c1")).toBe(false)
  })
})

// ── Hook harness ─────────────────────────────────────────────────────────────

type Api = ReturnType<typeof useInboxAutoCollapse>

function Capture({ lists, onResult }: { lists: InboxLists; onResult: (r: Api) => void }) {
  const api = useInboxAutoCollapse(lists)
  onResult(api)
  return null
}

async function renderHook(initial: InboxLists) {
  let latest!: Api
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Capture, { lists: initial, onResult: (r) => { latest = r } }),
    )
  })
  return {
    get current() {
      return latest
    },
    async rerender(lists: InboxLists) {
      await act(async () => {
        renderer.update(
          React.createElement(Capture, { lists, onResult: (r) => { latest = r } }),
        )
      })
    },
    async call(fn: () => void) {
      await act(async () => {
        fn()
      })
    },
  }
}

// ── useInboxAutoCollapse ─────────────────────────────────────────────────────

describe("useInboxAutoCollapse", () => {
  it("collapses once a watched channel leaves the list", async () => {
    const withC1: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])] }
    const hook = await renderHook(withC1)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("channel:c1"))
    // Still present → stays open.
    await hook.rerender(withC1)
    expect(hook.current.open).toBe(true)
    // c1 gone → collapses.
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(false)
  })

  it("keeps the popover open when a watched channel persists (navigate-only forum parent)", async () => {
    const withForum: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "forum1", children: ["p1"] }])] }
    const hook = await renderHook(withForum)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("channel:forum1"))
    // Re-render with the parent still present (posts unread) → stays open.
    await hook.rerender({ ...EMPTY, unreads: [server("s1", [{ id: "forum1", children: ["p1"] }])] })
    expect(hook.current.open).toBe(true)
  })

  it("collapses when a watched DM leaves the list", async () => {
    const withD1: InboxLists = { ...EMPTY, unreadDms: [dm("d1")] }
    const hook = await renderHook(withD1)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("dm:d1"))
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(false)
  })

  it("collapses when a watched mention leaves the list", async () => {
    const withM1: InboxLists = { ...EMPTY, mentions: [mention("m1")] }
    const hook = await renderHook(withM1)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("mention:m1"))
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(false)
  })

  it("clears the pending key after a collapse — later unrelated changes don't re-close", async () => {
    const withC1D1: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])], unreadDms: [dm("d1")] }
    const hook = await renderHook(withC1D1)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("channel:c1"))
    // c1 leaves → collapse.
    await hook.rerender({ ...EMPTY, unreadDms: [dm("d1")] })
    expect(hook.current.open).toBe(false)
    // Reopen by user; then an unrelated DM leaves. Must NOT auto-close (no key).
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(true)
  })

  it("reopening (onOpenChange(true)) clears a stale pending key so it can't fire later", async () => {
    const withC1: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])] }
    const hook = await renderHook(withC1)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("channel:c1"))
    // User closes manually, then reopens — this clears the pending key.
    await hook.call(() => hook.current.onOpenChange(false))
    await hook.call(() => hook.current.onOpenChange(true))
    // c1 now leaves → must stay open (stale key was cleared on reopen).
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(true)
  })

  it("does nothing while closed even if a watched item leaves", async () => {
    const withC1: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])] }
    const hook = await renderHook(withC1)
    // watchItem set while popover is closed (open=false by default).
    await hook.call(() => hook.current.watchItem("channel:c1"))
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(false)
  })

  it("does not collapse without a watchItem call (mark-all-read / remove-mention path)", async () => {
    const full: InboxLists = { unreads: [server("s1", [{ id: "c1" }])], unreadDms: [dm("d1")], mentions: [mention("m1")] }
    const hook = await renderHook(full)
    await hook.call(() => hook.current.onOpenChange(true))
    // No watchItem — everything empties (e.g. Mark all read).
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(true)
  })

  // Regression for the watch-key overwrite bug: the shell's onOpenMention calls
  // openServerChannel(serverId, channelId, `mention:<id>`), and openServerChannel
  // forwards its `watchKey` param to watchItem. If openServerChannel ignored the
  // param and hardcoded `channel:<cid>`, the mention key would be overwritten.
  // These two tests pin that the forwarded key wins.
  it("openServerChannel forwards an explicit watchKey (mention path) instead of hardcoding channel:<cid>", async () => {
    // Mirror the shell wiring: openServerChannel(sid, cid, watchKey) → watchItem(watchKey).
    const before: InboxLists = {
      unreads: [server("s1", [{ id: "c1", children: ["p1"] }])],
      unreadDms: [],
      mentions: [mention("m1", "c1")],
    }
    const hook = await renderHook(before)
    const openServerChannel = (_sid: string, cid: string, watchKey = `channel:${cid}`) => {
      hook.current.watchItem(watchKey)
    }
    await hook.call(() => hook.current.onOpenChange(true))
    // onOpenMention path: pass the mention key.
    await hook.call(() => openServerChannel("s1", "c1", "mention:m1"))
    // Channel c1 stays (hosts child p1); only the mention leaves.
    await hook.rerender({ unreads: [server("s1", [{ id: "c1", children: ["p1"] }])], unreadDms: [], mentions: [] })
    // If the channel key had overwritten the mention key, c1 would still be
    // present and this would be `true` (the bug). It must collapse.
    expect(hook.current.open).toBe(false)
  })

  it("openServerChannel defaults watchKey to channel:<cid> when the caller omits it (plain channel click)", async () => {
    const before: InboxLists = { ...EMPTY, unreads: [server("s1", [{ id: "c1" }])] }
    const hook = await renderHook(before)
    const openServerChannel = (_sid: string, cid: string, watchKey = `channel:${cid}`) => {
      hook.current.watchItem(watchKey)
    }
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => openServerChannel("s1", "c1"))
    await hook.rerender(EMPTY)
    expect(hook.current.open).toBe(false)
  })

  it("watching the mention key collapses even when the mention's channel persists to host unread children", async () => {
    // Mention m1 lives in c1; c1 also hosts an unread child p1. Reading the
    // channel clears m1 but keeps c1 (to host p1). Because we watch the mention
    // key — not channel:c1 — the popover still collapses when m1 leaves.
    const before: InboxLists = {
      unreads: [server("s1", [{ id: "c1", children: ["p1"] }])],
      unreadDms: [],
      mentions: [mention("m1", "c1")],
    }
    const hook = await renderHook(before)
    await hook.call(() => hook.current.onOpenChange(true))
    await hook.call(() => hook.current.watchItem("mention:m1"))
    // m1 gone, c1 still present.
    await hook.rerender({ unreads: [server("s1", [{ id: "c1", children: ["p1"] }])], unreadDms: [], mentions: [] })
    expect(hook.current.open).toBe(false)
  })
})
