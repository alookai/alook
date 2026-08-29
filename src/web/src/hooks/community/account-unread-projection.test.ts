import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import {
  acceptAccountUnreadPrimarySnapshot,
  AccountUnreadProjection,
  disposeAccountUnreadProjection,
  getActiveAccountUnreadProjection,
  getAccountUnreadProjection,
  MAX_EXACT_ARRIVALS,
  MAX_EXACT_ARRIVALS_PER_CHANNEL,
  MAX_STICKY_SCOPES,
} from "./account-unread-projection"

describe("AccountUnreadProjection", () => {
  it("is a per-query-client and account singleton", () => {
    const client = new QueryClient()
    expect(getAccountUnreadProjection(client, "u1"))
      .toBe(getAccountUnreadProjection(client, "u1"))
    expect(getAccountUnreadProjection(client, "u1"))
      .not.toBe(getAccountUnreadProjection(client, "u2"))
  })

  it("publishes synchronous changes and stops after unsubscribe", () => {
    const projection = new AccountUnreadProjection("u1")
    const listener = vi.fn()
    const unsubscribe = projection.subscribe(listener)

    projection.recordArrival({ channelId: "dm", seq: 1 })
    expect(listener).toHaveBeenCalledOnce()
    expect(projection.getSnapshot()).toBe(1)

    unsubscribe()
    projection.recordArrival({ channelId: "dm", seq: 2 })
    expect(listener).toHaveBeenCalledOnce()
    expect(projection.projectUnread("dms", "dm", false)).toBe(true)
  })

  it("ignores malformed arrivals and read cursors", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "", seq: 1 })
    projection.recordRead("c1", 0)
    projection.recordOptimisticRead("c1", Number.NaN, 1)
    expect(projection.getSnapshot()).toBe(0)
    expect(projection.hasPending()).toBe(false)
  })

  it("records each rolling-deploy legacy snapshot once", () => {
    const projection = new AccountUnreadProjection("u1")
    const snapshot = {}
    projection.recordLegacySnapshot(snapshot, [{
      family: "servers",
      channelId: "legacy",
      serverId: "s1",
    }])
    const version = projection.getSnapshot()
    projection.recordLegacySnapshot(snapshot, [{
      family: "servers",
      channelId: "legacy",
      serverId: "s1",
    }])
    expect(projection.getSnapshot()).toBe(version)
    expect(projection.projectServerUnread("s1", [], false)).toBe(true)
  })

  it("merges duplicate exact evidence and ignores older read cursors", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", messageId: "m1", seq: 2 })
    projection.recordArrival({
      channelId: "c1",
      railChannelId: "forum",
      messageId: "m1",
      seq: 2,
      isMention: true,
    })
    projection.recordRead("c1", 1)
    projection.recordRead("c1", 1)

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("dms", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
  })

  it("does not retain an exact replay already covered by the primary cursor", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.acceptPrimarySnapshot({
      revision: 1,
      readStates: [{ channelId: "c1", lastReadSeq: 4 }],
    })

    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      messageId: "m4",
      seq: 4,
      isMention: true,
    })

    expect(projection.hasPending()).toBe(false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(false)
  })

  it("keeps an exact arrival until matching family evidence absorbs it", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", messageId: "m2", seq: 2 })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    projection.absorbFamily("servers", [{ channelId: "c1", lastUnreadSeq: 1 }])
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    projection.absorbFamily("servers", [{ channelId: "c1", lastUnreadSeq: 2 }])
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("does not clear a sticky unknown on empty, same, or truncated evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.absorbFamily("inbox-unreads", [{ channelId: "c1", lastUnreadSeq: 8 }])
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    projection.absorbFamily("inbox-unreads", [], { truncated: false })
    projection.absorbFamily("inbox-unreads", [{ channelId: "c1", lastUnreadSeq: 8 }])
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(true)
    projection.absorbFamily("inbox-unreads", [{ channelId: "c1", lastUnreadSeq: 9 }])
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(false)
  })

  it("lets a visible read cover exact seq but never an unsequenced sticky bump", () => {
    const exact = new AccountUnreadProjection("u1")
    exact.recordArrival({ channelId: "c1", serverId: "s1", seq: 4 })
    exact.recordRead("c1", 4)
    expect(exact.projectUnread("servers", "c1", false)).toBe(false)

    const sticky = new AccountUnreadProjection("u1")
    sticky.recordArrival({ channelId: "c1", serverId: "s1" })
    sticky.recordRead("c1", 99)
    expect(sticky.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("rolls back only the failed optimistic read generation", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 4 })
    projection.recordOptimisticRead("c1", 4, 1)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    projection.settleOptimisticRead(1, false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("commits an optimistic read at the greatest confirmed cursor", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 5 })
    projection.recordOptimisticRead("c1", 4, 2)
    projection.settleOptimisticRead(404, true, 5)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)

    projection.settleOptimisticRead(2, true, 5)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("settles overlapping optimistic generations independently", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 4 })
    projection.recordOptimisticRead("c1", 4, 1)
    projection.recordOptimisticRead("c1", 5, 2)
    projection.settleOptimisticRead(2, false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    projection.settleOptimisticRead(1, false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)

    projection.recordOptimisticRead("c1", 4, 3)
    projection.settleOptimisticRead(3, true, 4)
    projection.recordOptimisticRead("c1", 5, 4)
    projection.settleOptimisticRead(4, false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("lets an accepted primary cursor settle matching optimistic generations", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 4 })
    projection.recordOptimisticRead("c1", 4, 1)
    projection.acceptPrimarySnapshot({
      revision: 1,
      readStates: [{ channelId: "c1", lastReadSeq: 4 }],
    })
    projection.settleOptimisticRead(1, false)
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("keeps post-mark-all arrivals while hiding only the captured prefix", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const token = projection.beginMarkAll("channels")
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(false)
    projection.recordArrival({ channelId: "c2", serverId: "s1", seq: 2 })
    expect(projection.projectUnread("servers", "c2", false)).toBe(true)
    projection.rollbackMarkAll(token)
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(true)
  })

  it("keeps channel and DM mark-all domains independent inside Inbox", () => {
    const projection = new AccountUnreadProjection("u1")
    const channelToken = projection.beginMarkAll("channels")
    expect(projection.projectUnread("inbox-unreads", "channel", true, 2)).toBe(false)
    expect(projection.projectUnread("inbox-unreads", "dm", true, 2, "dms")).toBe(true)
    projection.rollbackMarkAll(channelToken)

    const dmToken = projection.beginMarkAll("dms")
    expect(projection.projectUnread("inbox-unreads", "channel", true, 2)).toBe(true)
    expect(projection.projectUnread("inbox-unreads", "dm", true, 2, "dms")).toBe(false)
    projection.rollbackMarkAll(dmToken)
  })

  it("retires only the accepted mark-all domain prefix and preserves later arrivals", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "channel-before",
      serverId: "s1",
      isMention: true,
    })
    const channelToken = projection.beginMarkAll("channels")
    const mentionToken = projection.beginMarkAll("mentions")
    projection.recordArrival({ channelId: "channel-after", serverId: "s1" })
    projection.commitMarkAll(channelToken, 4)
    projection.commitMarkAll(mentionToken, 6)

    projection.acceptPrimarySnapshot({ revision: 4, readStates: [] })
    expect(projection.projectUnread("servers", "channel-before", false)).toBe(false)
    expect(projection.projectUnread("servers", "channel-after", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "channel-before", false)).toBe(false)

    projection.acceptPrimarySnapshot({ revision: 6, readStates: [] })
    expect(projection.projectUnread("inbox-mentions", "channel-before", false)).toBe(false)
  })

  it("retires exact family bits and overflow sentinels at an accepted fence", () => {
    const exact = new AccountUnreadProjection("u1")
    exact.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const channel = exact.beginMarkAll("channels")
    exact.recordArrival({ channelId: "c2", serverId: "s1", seq: 2 })
    exact.commitMarkAll(channel, 2)
    exact.acceptPrimarySnapshot({ revision: 2, readStates: [] })
    expect(exact.projectUnread("servers", "c1", false)).toBe(false)
    expect(exact.projectUnread("servers", "c2", false)).toBe(true)

    const overflow = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      overflow.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    overflow.recordArrival({ channelId: "overflow", serverId: "s-overflow" })
    const token = overflow.beginMarkAll("channels")
    overflow.commitMarkAll(token, 3)
    overflow.acceptPrimarySnapshot({ revision: 3, readStates: [] })
    expect(overflow.projectUnread("servers", "unrelated", false)).toBe(false)
  })

  it("applies primary snapshots only to the active account", () => {
    const client = new QueryClient()
    const first = getAccountUnreadProjection(client, "u1")
    first.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })
    const second = getAccountUnreadProjection(client, "u2")
    second.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })

    acceptAccountUnreadPrimarySnapshot(client, {
      revision: 1,
      readStates: [{ channelId: "c1", lastReadSeq: 2 }],
    })

    expect(first.projectUnread("servers", "c1", false)).toBe(true)
    expect(second.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("does not create or update a projection when no account is active", () => {
    const client = new QueryClient()
    acceptAccountUnreadPrimarySnapshot(client, {
      revision: 1,
      readStates: [{ channelId: "c1", lastReadSeq: 2 }],
    })
    const anonymous = getActiveAccountUnreadProjection(client)
    expect(anonymous.ownerUserId).toBe("__anonymous__")
    expect(anonymous.getSnapshot()).toBe(0)
  })

  it("never derives a numeric server mention increment from isMention", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      seq: 2,
      isMention: true,
    })
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 3,
      lastSeq: 1,
    }])).toBe(3)
    expect(projection.projectMentionCount("inbox-mentions", "c1", 0, 1)).toBe(1)
  })

  it("absorbs mention arrivals with mention-seq and unread-seq evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordMentionArrival({ channelId: "c1", seq: 4, isMention: true })
    projection.absorbFamily("inbox-mentions", [{
      channelId: "c1",
      lastUnreadSeq: 5,
      lastMentionSeq: 3,
    }])
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)

    projection.absorbFamily("inbox-mentions", [{
      channelId: "c1",
      lastUnreadSeq: 5,
      lastMentionSeq: null,
    }])
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(false)
  })

  it("absorbs a single-family sticky mention only after newer evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.absorbFamily("inbox-mentions", [{ channelId: "c1", lastUnreadSeq: 4 }])
    projection.recordMentionArrival({ channelId: "c1", isMention: true })
    projection.absorbFamily("inbox-mentions", [{ channelId: "c1", lastUnreadSeq: 5 }])
    expect(projection.hasPending("inbox-mentions", "mentions")).toBe(false)
  })

  it("skips arrivals and sticky scopes owned by another family", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "exact", serverId: "s1", seq: 2 })
    projection.recordArrival({ channelId: "sticky", serverId: "s1" })
    projection.absorbFamily("dms", [{ channelId: "exact", lastUnreadSeq: 3 }])
    expect(projection.projectUnread("servers", "exact", false)).toBe(true)
    expect(projection.projectUnread("servers", "sticky", false)).toBe(true)
  })

  it("ignores stale family evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })
    projection.absorbFamily("servers", [{ channelId: "c1", lastUnreadSeq: 2 }], {
      stale: true,
    })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("projects server and channel fallbacks, exact arrivals, and hidden forum children", () => {
    const projection = new AccountUnreadProjection("u1")
    expect(projection.projectServerUnread("s1", [], true)).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "c1", [], true)).toBe(true)

    projection.recordArrival({
      channelId: "post",
      railChannelId: "forum",
      serverId: "s1",
      seq: 2,
    })
    expect(projection.projectServerUnread("s1", [], false)).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "forum", [], false)).toBe(true)
    expect(projection.projectForumParentUnread(
      "s1",
      "forum",
      false,
      null,
      new Set(),
    )).toBe(true)
    expect(projection.projectForumParentUnread(
      "s1",
      "forum",
      false,
      null,
      new Set(["post"]),
    )).toBe(false)
    expect(projection.projectForumParentUnread(
      "s1",
      "forum",
      true,
      3,
      new Set(["post"]),
    )).toBe(true)
    expect(projection.projectServerUnread("other", [], false)).toBe(false)
  })

  it("projects sticky server, channel, and hidden-forum unread state", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "post",
      railChannelId: "forum",
      serverId: "s1",
    })
    expect(projection.projectServerUnread("s1", [], false)).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "forum", [], false)).toBe(true)
    expect(projection.projectForumParentUnread(
      "s1",
      "forum",
      false,
      null,
      new Set(),
    )).toBe(true)
  })

  it("projects canonical server sources and raw mention fallbacks", () => {
    const projection = new AccountUnreadProjection("u1")
    expect(projection.projectServerUnread("s1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }])).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "c1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }])).toBe(true)
    expect(projection.projectServerMentionCount("s1", [], 7)).toBe(7)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 3,
      lastSeq: 2,
    }])).toBe(3)
  })

  it("reports pending exact and sticky work by family and domain", () => {
    const exact = new AccountUnreadProjection("u1")
    exact.recordArrival({ channelId: "c1", serverId: "s1", seq: 1, isMention: true })
    expect(exact.hasPending("servers", "channels")).toBe(true)
    expect(exact.hasPending("inbox-mentions", "mentions")).toBe(true)
    expect(exact.hasPending("dms", "dms")).toBe(false)
    expect(exact.hasPending(undefined, "dms")).toBe(false)

    const sticky = new AccountUnreadProjection("u1")
    sticky.recordArrival({ channelId: "dm", isMention: true })
    expect(sticky.hasPending("dms")).toBe(true)
    expect(sticky.hasPending(undefined, "mentions")).toBe(true)
    expect(sticky.hasPending(undefined, "channels")).toBe(false)
    expect(sticky.hasPending("servers", "channels")).toBe(false)
  })

  it("degrades per-channel exact overflow to a sticky sentinel without losing unread", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let seq = 1; seq <= MAX_EXACT_ARRIVALS_PER_CHANNEL + 1; seq += 1) {
      projection.recordArrival({ channelId: "c1", serverId: "s1", seq })
    }
    projection.recordRead("c1", MAX_EXACT_ARRIVALS_PER_CHANNEL + 1)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("folds account-wide exact overflow into a sticky scope", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_EXACT_ARRIVALS; index += 1) {
      projection.recordArrival({
        channelId: `c${index}`,
        serverId: "s1",
        seq: 1,
      })
    }
    projection.recordArrival({ channelId: "overflow", serverId: "s1", seq: 1 })
    projection.recordRead("overflow", 99)
    expect(projection.projectUnread("servers", "overflow", false)).toBe(true)
  })

  it("keeps fixed family overflow conservative and generation-aware", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "overflow-before", serverId: "s-overflow" })
    expect(projection.projectServerChannelUnread(
      "s-overflow",
      "overflow-before",
      [],
    )).toBe(true)

    const token = projection.beginMarkAll("channels")
    expect(projection.projectServerChannelUnread(
      "s-overflow",
      "overflow-before",
      [],
    )).toBe(false)
    projection.recordArrival({ channelId: "overflow-after", serverId: "s-after" })
    expect(projection.projectServerChannelUnread("s-after", "overflow-after", [])).toBe(true)

    projection.commitMarkAll(token, 3)
    projection.acceptPrimarySnapshot({ revision: 3, readStates: [] })
    expect(projection.projectServerChannelUnread("s-after", "overflow-after", [])).toBe(true)
  })

  it("exposes fixed overflow sentinels through family pending checks", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "overflow", serverId: "s-overflow" })
    expect(projection.hasPending("servers")).toBe(true)
    expect(projection.hasPending("servers", "channels")).toBe(true)
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(true)
    expect(projection.projectServerUnread("unrelated", [], false)).toBe(true)
    expect(projection.projectForumParentUnread(
      "unrelated",
      "forum",
      false,
      null,
      new Set(),
    )).toBe(true)
  })

  it("clears a sentinel only with advancing evidence for its retained witness", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.absorbFamily("servers", [{ channelId: "overflow", lastUnreadSeq: 8 }])
    projection.recordArrival({ channelId: "overflow", serverId: "s-overflow" })

    projection.absorbFamily("servers", [{ channelId: "other", lastUnreadSeq: 999 }])
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(true)
    projection.absorbFamily("servers", [{ channelId: "overflow", lastUnreadSeq: 8 }])
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(true)
    projection.absorbFamily("servers", [{ channelId: "overflow", lastUnreadSeq: 9 }])
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(false)
  })

  it("clears a mention sentinel with advancing mention evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({
      channelId: "mention-overflow",
      serverId: "s-overflow",
      isMention: true,
    })
    expect(projection.hasPending("inbox-mentions", "mentions")).toBe(true)

    projection.absorbFamily("inbox-mentions", [{
      channelId: "mention-overflow",
      lastUnreadSeq: 1,
      lastMentionSeq: 1,
    }], { truncated: false })
    expect(projection.hasPending("inbox-mentions", "mentions")).toBe(false)
  })

  it("makes a sentinel non-clearable when another scope folds into it", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "first", serverId: "s-first" })
    projection.recordArrival({ channelId: "second", serverId: "s-second" })
    projection.absorbFamily("servers", [
      { channelId: "first", lastUnreadSeq: 9 },
      { channelId: "second", lastUnreadSeq: 9 },
    ])
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(true)
  })

  it("makes a normalized server-detail sentinel non-clearable across families", () => {
    const projection = new AccountUnreadProjection("u1")
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "shared", serverId: "s-first" })
    projection.recordArrival({ channelId: "shared", serverId: "s-second" })
    projection.absorbFamily("server-detail:s-first", [{
      channelId: "shared",
      lastUnreadSeq: 9,
    }])
    expect(projection.hasPending("server-detail:s-first", "channels")).toBe(true)
  })

  it("ignores superseded mark-all tokens", () => {
    const projection = new AccountUnreadProjection("u1")
    const first = projection.beginMarkAll("channels")
    const second = projection.beginMarkAll("channels")
    projection.commitMarkAll(first, 1)
    projection.rollbackMarkAll(first)
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(false)
    projection.rollbackMarkAll(second)
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(true)
  })

  it("refreshes a repeated sticky scope past a mark-all fence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    const token = projection.beginMarkAll("channels")
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    projection.rollbackMarkAll(token)
  })

  it("keeps sticky family epochs independent on the same channel", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    const token = projection.beginMarkAll("channels")
    projection.recordMentionArrival({ channelId: "c1", isMention: true })
    projection.commitMarkAll(token, 2)
    projection.acceptPrimarySnapshot({ revision: 2, readStates: [] })

    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
  })

  it("disposes one account or an entire query-client ledger", () => {
    const client = new QueryClient()
    const first = getAccountUnreadProjection(client, "u1")
    getAccountUnreadProjection(client, "u2")

    disposeAccountUnreadProjection(client, "u1")
    expect(getAccountUnreadProjection(client, "u1")).not.toBe(first)

    disposeAccountUnreadProjection(client)
    const anonymous = getActiveAccountUnreadProjection(client)
    expect(anonymous.ownerUserId).toBe("__anonymous__")
    disposeAccountUnreadProjection(new QueryClient())
  })
})
