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

  it("rejects unordered legacy rows until fresh access authority clears the fence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.retireAccessScope({ kind: "server", serverId: "s1" })
    projection.grantAccessScope({ kind: "server", serverId: "s1" })

    projection.recordLegacySnapshot({}, [{
      family: "inbox-unreads",
      channelId: "legacy",
      serverId: "s1",
    }])
    const authority = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(authority, [], {
      confirmedAccessScopes: [{ kind: "server", serverId: "s1" }],
    })

    expect(projection.projectUnread("inbox-unreads", "legacy", false)).toBe(false)
    expect(projection.inspectForTests().stickyCount).toBe(0)

    projection.recordLegacySnapshot({}, [{
      family: "inbox-unreads",
      channelId: "legacy",
      serverId: "s1",
    }])
    expect(projection.projectUnread("inbox-unreads", "legacy", false)).toBe(true)
  })

  it("merges duplicate exact evidence and ignores older read cursors", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", messageId: "m1", seq: 2 })
    projection.recordArrival({
      channelId: "c1",
      railChannelId: "forum",
      messageId: "m1",
      attentionId: "mention-1",
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

  it("keeps positive family evidence canonical until a later full snapshot omits it", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1", messageId: "m2", seq: 2 })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    const positive = projection.beginSnapshot("servers")
    projection.absorbSnapshot(positive, [{ channelId: "c1", serverId: "s1", lastUnreadSeq: 2 }])
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    const empty = projection.beginSnapshot("servers")
    projection.absorbSnapshot(empty, [])
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
  })

  it("retires sticky unknowns only from a full current snapshot", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    const truncated = projection.beginSnapshot("inbox-unreads", "channels")
    projection.absorbSnapshot(truncated, [], { truncated: true })
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(true)
    const full = projection.beginSnapshot("inbox-unreads", "channels")
    projection.absorbSnapshot(full, [])
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(false)
  })

  it("retires a covered sticky family after newer full positive evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    const token = projection.beginSnapshot("inbox-unreads", "channels")
    projection.absorbSnapshot(token, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 7,
    }])

    expect(projection.inspectForTests()).toMatchObject({
      sourceCount: 2,
      exactCount: 1,
      stickyCount: 1,
    })
    expect(projection.hasPending("inbox-unreads", "channels")).toBe(true)
    expect(projection.projectUnread(
      "inbox-unreads",
      "c1",
      false,
      undefined,
      "channels",
      { channelId: "c1", throughSeq: 7 },
    )).toBe(false)
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

  it("keeps positive mention evidence and retires it on a later full empty", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordMentionArrival({ channelId: "c1", seq: 4, isMention: true })
    const positive = projection.beginSnapshot("inbox-mentions")
    projection.absorbSnapshot(positive, [{
      channelId: "c1",
      lastUnreadSeq: 5,
      lastMentionSeq: 3,
    }])
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)

    const empty = projection.beginSnapshot("inbox-mentions")
    projection.absorbSnapshot(empty, [])
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(false)
  })

  it("retires a single-family sticky mention on authoritative absence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordMentionArrival({ channelId: "c1", isMention: true })
    const token = projection.beginSnapshot("inbox-mentions")
    projection.absorbSnapshot(token, [])
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
    expect(projection.projectServerUnread("s1", [], true)).toBe(false)
    expect(projection.projectServerChannelUnread("s1", "c1", [], true)).toBe(false)

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

  it("projects canonical server sources without aggregate-only fallbacks", () => {
    const projection = new AccountUnreadProjection("u1")
    expect(projection.projectServerUnread("s1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }])).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "c1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }])).toBe(true)
    expect(projection.projectServerMentionCount("s1", [], 7)).toBe(0)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 3,
      lastSeq: 2,
    }])).toBe(3)
  })

  it("excludes only the reserved channel boundary and preserves later arrivals", () => {
    const projection = new AccountUnreadProjection("u1")
    const exclusion = { channelId: "c1", throughSeq: 2 }
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })

    expect(projection.projectUnread(
      "servers",
      "c1",
      true,
      2,
      "channels",
      exclusion,
    )).toBe(false)
    expect(projection.projectServerUnread("s1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }], false, exclusion)).toBe(false)
    expect(projection.projectServerChannelUnread("s1", "c1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }], false, exclusion)).toBe(false)
    expect(projection.hasPending("servers", "channels", exclusion)).toBe(false)

    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 3 })
    expect(projection.projectUnread(
      "servers",
      "c1",
      true,
      2,
      "channels",
      exclusion,
    )).toBe(true)
    expect(projection.projectServerUnread("s1", [{
      channelId: "c1",
      lastUnreadSeq: 2,
    }], false, exclusion)).toBe(true)
    expect(projection.hasPending("servers", "channels", exclusion)).toBe(true)
  })

  it("keeps unrelated aggregate sources visible during an exact reservation", () => {
    const projection = new AccountUnreadProjection("u1")
    const exclusion = { channelId: "post", throughSeq: 4 }
    projection.recordArrival({
      channelId: "post",
      railChannelId: "forum",
      serverId: "s1",
      seq: 4,
    })
    projection.recordArrival({ channelId: "sibling", serverId: "s1", seq: 1 })

    expect(projection.projectServerUnread("s1", [], false, exclusion)).toBe(true)
    expect(projection.projectServerChannelUnread(
      "s1",
      "forum",
      [],
      false,
      exclusion,
    )).toBe(false)
    expect(projection.projectForumParentUnread(
      "s1",
      "forum",
      false,
      null,
      new Set(),
      exclusion,
    )).toBe(false)
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

  it("evicts the oldest scoped sticky source without inventing an unrelated dot", () => {
    const projection = new AccountUnreadProjection("u1")
    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "overflow", serverId: "s-overflow" })
    expect(projection.inspectForTests().stickyCount).toBe(MAX_STICKY_SCOPES)
    expect(projection.projectUnread("servers", "c0", false)).toBe(false)
    expect(projection.projectUnread("servers", "overflow", false)).toBe(true)
    expect(projection.hasPending("servers")).toBe(true)
    expect(projection.hasPending("servers", "channels")).toBe(true)
    expect(projection.projectUnread("servers", "unrelated", false)).toBe(false)
    expect(projection.projectServerUnread("unrelated", [], false)).toBe(false)
    expect(projection.projectForumParentUnread(
      "unrelated",
      "forum",
      false,
      null,
      new Set(),
    )).toBe(false)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it("coalesces reconciliation across repeated sticky overflow", () => {
    const projection = new AccountUnreadProjection("u1")
    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    for (let index = 0; index < MAX_STICKY_SCOPES; index += 1) {
      projection.recordArrival({ channelId: `c${index}`, serverId: `s${index}` })
    }
    projection.recordArrival({ channelId: "first", serverId: "s-first" })
    projection.recordArrival({ channelId: "second", serverId: "s-second" })
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it("retires a compacted scoped source on a complete empty snapshot", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    for (let seq = 1; seq <= MAX_EXACT_ARRIVALS_PER_CHANNEL + 1; seq += 1) {
      projection.recordArrival({ channelId: "shared", serverId: "s1", seq })
    }
    const token = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(token, [])
    expect(projection.projectUnread("servers", "shared", false)).toBe(false)
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

  it("keeps a post-mark-all mention as a new ordinary and attention source", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1" })
    const token = projection.beginMarkAll("channels")
    projection.recordMentionArrival({ channelId: "c1", isMention: true })
    projection.commitMarkAll(token, 2)
    projection.acceptPrimarySnapshot({ revision: 2, readStates: [] })

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
  })

  it("stores one canonical source across unread and attention families", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      messageId: "m1",
      seq: 7,
      isMention: true,
    })
    expect(projection.inspectForTests().sourceCount).toBe(1)
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
  })

  it("coalesces bundled unread and mention events by channel sequence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 7 })
    projection.recordMentionArrival({ channelId: "c1", messageId: "m1", seq: 7 })

    expect(projection.inspectForTests().sourceCount).toBe(1)
    expect(projection.projectUnread("inbox-unreads", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
  })

  it("excludes the reserved mention from the server attention badge", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      messageId: "m1",
      seq: 7,
      isMention: true,
    })

    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 1,
      lastSeq: 7,
    }], 1, { channelId: "c1", throughSeq: 7 })).toBe(0)
  })

  it("upgrades a correlated unsequenced mention to the later exact unread source", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordMentionArrival({ channelId: "c1", messageId: "m1" })
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      messageId: "m1",
      seq: 7,
    })

    expect(projection.inspectForTests()).toMatchObject({
      sourceCount: 1,
      exactCount: 1,
      stickyCount: 0,
    })
    const exclusion = { channelId: "c1", throughSeq: 7 }
    expect(projection.projectUnread(
      "inbox-unreads",
      "c1",
      false,
      undefined,
      "channels",
      exclusion,
    )).toBe(false)
    expect(projection.projectUnread(
      "inbox-mentions",
      "c1",
      false,
      undefined,
      "mentions",
      exclusion,
    )).toBe(false)
  })

  it("enriches a bump-first sticky before a truncated exact mention snapshot", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "post-1",
      serverId: "s1",
      railChannelId: "forum-1",
      isMention: true,
    })
    projection.recordMentionArrival({ channelId: "post-1", messageId: "m1" })
    const token = projection.beginSnapshot("inbox-mentions", "mentions")
    projection.absorbSnapshot(token, [{
      channelId: "post-1",
      serverId: "s1",
      railChannelId: "forum-1",
      messageId: "m1",
      attentionId: "attention-1",
      lastUnreadSeq: 7,
      lastMentionSeq: 7,
    }], { truncated: true })

    expect(projection.inspectForTests()).toMatchObject({
      sourceCount: 1,
      exactCount: 1,
      stickyCount: 0,
    })
  })

  it("keeps m1 to m2 to m1 sticky identities aggregated", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordMentionArrival({ channelId: "c1", messageId: "m1" })
    projection.recordMentionArrival({ channelId: "c1", messageId: "m2" })
    projection.recordMentionArrival({ channelId: "c1", messageId: "m1" })
    projection.recordArrival({ channelId: "c1", messageId: "m1", seq: 7 })

    expect(projection.inspectForTests()).toMatchObject({
      sourceCount: 2,
      exactCount: 1,
      stickyCount: 1,
    })
  })

  it("does not classify an unscoped mention frame as a DM", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordMentionArrival({ channelId: "unknown", seq: 7 })

    expect(projection.projectUnread("inbox-unreads", "unknown", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "unknown", false)).toBe(true)
    expect(projection.projectUnread("dms", "unknown", false)).toBe(false)
  })

  it("keeps live and snapshot mentions in a previously known DM family", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "dm", seq: 1 })
    projection.recordMentionArrival({ channelId: "dm", seq: 2 })
    projection.recordRead("dm", 1)

    expect(projection.projectUnread("dms", "dm", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "dm", false)).toBe(true)

    const token = projection.beginSnapshot("inbox-mentions", "mentions")
    projection.absorbSnapshot(token, [{
      channelId: "dm",
      lastUnreadSeq: 3,
      lastMentionSeq: 3,
    }], { truncated: true })
    projection.recordRead("dm", 2)

    expect(projection.projectUnread("dms", "dm", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "dm", false)).toBe(true)
  })

  it("projects an exact attention row without borrowing a newer channel source", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordMentionArrival({ channelId: "c1", seq: 4, isMention: true })
    projection.recordMentionArrival({ channelId: "c1", seq: 5, isMention: true })
    const exclusion = { channelId: "c1", throughSeq: 4 }

    expect(projection.projectUnread(
      "inbox-mentions",
      "c1",
      true,
      4,
      "mentions",
      exclusion,
      true,
    )).toBe(false)
    expect(projection.projectUnread(
      "inbox-mentions",
      "c1",
      true,
      5,
      "mentions",
      exclusion,
      true,
    )).toBe(true)
  })

  it("uses full absence as negative evidence but keeps post-request arrivals", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "before", serverId: "s1", seq: 1 })
    const token = projection.beginSnapshot("servers", "channels")
    projection.recordArrival({ channelId: "after", serverId: "s1", seq: 2 })
    projection.absorbSnapshot(token, [])
    expect(projection.projectUnread("servers", "before", false)).toBe(false)
    expect(projection.projectUnread("servers", "after", false)).toBe(true)
  })

  it("does not let a pre-mark-all snapshot refresh an old source past the fence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "before", serverId: "s1", seq: 1 })
    const snapshot = projection.beginSnapshot("servers")
    const markAll = projection.beginMarkAll("channels")

    projection.absorbSnapshot(snapshot, [{
      channelId: "before",
      serverId: "s1",
      lastUnreadSeq: 1,
    }])

    expect(projection.projectUnread("servers", "before", false)).toBe(false)
    projection.rollbackMarkAll(markAll)
    expect(projection.projectUnread("servers", "before", false)).toBe(true)
  })

  it("keeps a source confirmed by a newer snapshot when an older empty arrives last", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const older = projection.beginSnapshot("servers", "channels")
    const newer = projection.beginSnapshot("servers", "channels")

    projection.absorbSnapshot(newer, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 1,
    }])
    projection.absorbSnapshot(older, [])

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("treats stale and truncated snapshots as positive-only", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const stale = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(stale, [], { stale: true })
    const truncated = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(truncated, [], { truncated: true })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)

    const positive = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(positive, [{
      channelId: "c2",
      serverId: "s1",
      lastUnreadSeq: 2,
    }], { stale: true })
    expect(projection.projectUnread("servers", "c2", false)).toBe(true)
  })

  it("merges a positive family snapshot with its default domain", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    const beginSnapshot = vi.spyOn(projection, "beginSnapshot")

    projection.mergeSources("dms", [{ channelId: "dm", lastUnreadSeq: 2 }])

    expect(beginSnapshot).toHaveBeenCalledWith("dms", "dms")
    expect(projection.projectUnread("dms", "dm", false)).toBe(true)
  })

  it("treats snapshots started before policy hydration as positive-only", () => {
    const projection = new AccountUnreadProjection("u1")
    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const token = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(token, [])
    projection.setNotificationPolicy({ server: { s1: "all" } })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it("reconciles pre-policy snapshots that would retire exact or sticky attention", () => {
    const exact = new AccountUnreadProjection("u1")
    const exactReconcile = vi.fn()
    exact.setReconcileScheduler(exactReconcile)
    exact.recordArrival({ channelId: "channel", serverId: "s1", seq: 1, isMention: true })
    const exactToken = exact.beginSnapshot("servers", "channels")
    exact.absorbSnapshot(exactToken, [{
      channelId: "channel",
      serverId: "s1",
      lastUnreadSeq: 1,
    }])
    exact.setNotificationPolicy({})

    expect(exact.projectUnread("servers", "channel", false)).toBe(true)
    expect(exactReconcile).toHaveBeenCalledOnce()

    const sticky = new AccountUnreadProjection("u1")
    const stickyReconcile = vi.fn()
    sticky.setReconcileScheduler(stickyReconcile)
    sticky.recordArrival({ channelId: "dm", isMention: true })
    const stickyToken = sticky.beginSnapshot("dms", "dms")
    sticky.absorbSnapshot(stickyToken, [{ channelId: "dm", lastUnreadSeq: 1 }])
    sticky.setNotificationPolicy({})

    expect(sticky.projectUnread("dms", "dm", false)).toBe(true)
    expect(stickyReconcile).toHaveBeenCalledOnce()
  })

  it("does not refetch a pre-policy snapshot that had no negative work", () => {
    const projection = new AccountUnreadProjection("u1")
    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    const token = projection.beginSnapshot("dms", "dms")
    projection.absorbSnapshot(token, [])

    projection.setNotificationPolicy({})

    expect(reconcile).not.toHaveBeenCalled()
  })

  it("makes an old-policy full empty positive-only and coalesces reconciliation", () => {
    const projection = new AccountUnreadProjection("u1")
    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    projection.setNotificationPolicy({ server: { s1: "all" } })
    reconcile.mockClear()
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const token = projection.beginSnapshot("servers", "channels")
    projection.setNotificationPolicy({ server: { s1: "nothing" } })
    projection.absorbSnapshot(token, [])
    projection.absorbSnapshot(token, [])
    expect(reconcile).toHaveBeenCalledOnce()
    projection.setNotificationPolicy({ server: { s1: "all" } })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("runs a reconciliation requested before its scheduler attaches", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    const token = projection.beginSnapshot("servers")
    projection.setNotificationPolicy({ server: { s1: "nothing" } })
    projection.absorbSnapshot(token, [])

    const reconcile = vi.fn()
    projection.setReconcileScheduler(reconcile)
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it("absorbs each issued snapshot token at most once", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    const token = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(token, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 1,
    }])
    projection.absorbSnapshot(token, [{
      channelId: "c2",
      serverId: "s1",
      lastUnreadSeq: 2,
    }])

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("servers", "c2", false)).toBe(false)
  })

  it("applies exact channel over parent over server policy without consuming sources", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({
      channelId: "child",
      railChannelId: "parent",
      serverId: "s1",
      seq: 1,
      isMention: true,
    })
    const before = projection.inspectForTests()
    projection.setNotificationPolicy({
      server: { s1: "nothing" },
      channel: { parent: "mentions", child: "all" },
    })
    expect(projection.projectUnread("servers", "child", false)).toBe(true)
    projection.setNotificationPolicy({
      server: { s1: "nothing" },
      channel: { parent: "mentions" },
    })
    expect(projection.projectUnread("servers", "child", false)).toBe(true)
    projection.setNotificationPolicy({ server: { s1: "nothing" } })
    expect(projection.projectUnread("servers", "child", false)).toBe(false)
    projection.setNotificationPolicy({ server: { s1: "all" } })
    expect(projection.projectUnread("servers", "child", false)).toBe(true)
    expect(projection.inspectForTests().sourceCount).toBe(before.sourceCount)
    expect(projection.inspectForTests().readState).toEqual(before.readState)
  })

  it("shows only attention-bearing unread under mentions policy", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "plain", serverId: "s1", seq: 1 })
    projection.recordArrival({
      channelId: "attention",
      serverId: "s1",
      seq: 1,
      isMention: true,
    })
    projection.setNotificationPolicy({ server: { s1: "mentions" } })
    expect(projection.projectUnread("servers", "plain", false)).toBe(false)
    expect(projection.projectUnread("servers", "attention", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "attention", false)).toBe(true)
  })

  it("does not let a retired mention identity qualify a later plain raw row", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({ server: { s1: "mentions" } })
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      seq: 1,
      isMention: true,
    })
    projection.recordRead("c1", 1)

    expect(projection.inspectForTests().sourceCount).toBe(0)
    expect(projection.projectUnread("inbox-unreads", "c1", true, 2)).toBe(false)

    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      seq: 2,
      isMention: true,
    })
    expect(projection.projectUnread("inbox-unreads", "c1", true, 2)).toBe(true)
  })

  it("rolls back one policy overlay without overwriting a newer committed overlay", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({ server: { s1: "all" } })
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const older = projection.beginNotificationPolicyOverlay({
      kind: "server",
      id: "s1",
      level: "nothing",
    })
    const newer = projection.beginNotificationPolicyOverlay({
      kind: "channel",
      id: "c1",
      level: "all",
    })

    projection.commitNotificationPolicyOverlay(newer)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    projection.rollbackNotificationPolicyOverlay(older)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("rolls a channel-default overlay back to the exact override", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({
      server: { s1: "nothing" },
      channel: { c1: "all" },
    })
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const token = projection.beginNotificationPolicyOverlay({
      kind: "channel",
      id: "c1",
      level: null,
    })

    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    projection.rollbackNotificationPolicyOverlay(token)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("dismisses only the matching attention facet and rolls it back", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({
      channelId: "c1",
      serverId: "s1",
      messageId: "m1",
      seq: 4,
      isMention: true,
    })
    const token = projection.beginDismissMention({
      mentionId: "mention-1",
      channelId: "c1",
      seq: 4,
    })
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(false)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 2,
      lastSeq: 4,
    }])).toBe(1)
    projection.rollbackDismissMention(token)
    expect(projection.projectUnread("inbox-mentions", "c1", false)).toBe(true)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 2,
      lastSeq: 4,
    }])).toBe(2)

    const staleSnapshot = projection.beginSnapshot("inbox-mentions", "mentions")
    const committed = projection.beginDismissMention({
      mentionId: "mention-1",
      channelId: "c1",
      seq: 4,
    })
    projection.commitDismissMention(committed, 3)
    projection.absorbSnapshot(staleSnapshot, [], { truncated: false })
    expect(projection.projectUnread(
      "inbox-mentions",
      "c1",
      true,
      4,
      "mentions",
      null,
      true,
      "mention-1",
    )).toBe(false)
    projection.absorbFamily("servers", [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 4,
      lastMentionSeq: 4,
      isMention: true,
    }])
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 2,
      lastSeq: 4,
    }])).toBe(1)

    const confirmingSnapshot = projection.beginSnapshot("inbox-mentions", "mentions")
    projection.absorbSnapshot(confirmingSnapshot, [], { truncated: false })
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1",
      count: 2,
      lastSeq: 4,
    }])).toBe(2)
  })

  it("keeps same-seq sibling attention identities and counts only direct mentions", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    for (const attentionId of ["reply-1", "mention-1"]) {
      projection.recordArrival({
        channelId: "c1",
        serverId: "s1",
        messageId: "m1",
        attentionId,
        seq: 4,
        isMention: true,
      })
    }

    const reply = projection.beginDismissMention({
      mentionId: "reply-1",
      channelId: "c1",
      seq: 4,
      countsServerMention: false,
    })
    expect(projection.projectUnread(
      "inbox-mentions", "c1", true, 4, "mentions", null, true, "reply-1",
    )).toBe(false)
    expect(projection.projectUnread(
      "inbox-mentions", "c1", true, 4, "mentions", null, true, "mention-1",
    )).toBe(true)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1", count: 1, lastSeq: 4,
    }])).toBe(1)

    projection.rollbackDismissMention(reply)
    projection.beginDismissMention({
      mentionId: "mention-1",
      channelId: "c1",
      seq: 4,
      countsServerMention: true,
    })
    expect(projection.projectUnread(
      "inbox-mentions", "c1", true, 4, "mentions", null, true, "mention-1",
    )).toBe(false)
    expect(projection.projectUnread(
      "inbox-mentions", "c1", true, 4, "mentions", null, true, "reply-1",
    )).toBe(true)
    expect(projection.projectServerMentionCount("s1", [{
      channelId: "c1", count: 1, lastSeq: 4,
    }])).toBe(0)
  })

  it("does not let a revision hint alone retire a committed mark-all fence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "sticky", serverId: "s1" })
    const token = projection.beginMarkAll("channels")
    projection.commitMarkAll(token, 5)
    projection.acceptPrimarySnapshot({ revision: 5, readStates: [] })
    projection.rollbackMarkAll(token)
    expect(projection.projectUnread("servers", "sticky", false)).toBe(true)
  })

  it("retires access scope atomically and restores it on rollback", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const token = projection.beginScopeRetirement({ kind: "server", serverId: "s1" })
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })
    projection.rollbackScopeRetirement(token)
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    projection.retireAccessScope({ kind: "server", serverId: "s1" })
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(false)
    projection.grantAccessScope({ kind: "server", serverId: "s1" })
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(false)
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 2 })
    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    const confirmation = projection.beginAccessConfirmation()
    projection.confirmAccessScopes(
      [{ kind: "server", serverId: "s1" }],
      confirmation,
    )
    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("lets a post-retirement authority recover a committed access tombstone", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    projection.retireAccessScope({ kind: "server", serverId: "s1" })

    const serverSnapshot = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(serverSnapshot, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 2,
    }], {
      confirmedAccessScopes: [{ kind: "server", serverId: "s1" }],
    })

    expect(projection.projectUnread("servers", "c1", false)).toBe(true)
    expect(projection.inspectForTests().sourceCount).toBe(1)

    projection.retireAccessScope({ kind: "channel", channelId: "c1" })
    const channelSnapshot = projection.beginSnapshot("server-detail:s1", "channels")
    projection.absorbSnapshot(channelSnapshot, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 3,
    }], {
      confirmedAccessScopes: [{ kind: "channel", channelId: "c1" }],
    })

    expect(projection.projectUnread("server-detail:s1", "c1", false)).toBe(true)
  })

  it("rejects a pre-retirement snapshot after a later access grant", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const staleSnapshot = projection.beginSnapshot("servers", "channels")

    projection.retireAccessScope({ kind: "server", serverId: "s1" })
    projection.grantAccessScope({ kind: "server", serverId: "s1" })
    projection.absorbSnapshot(staleSnapshot, [{
      channelId: "c1",
      serverId: "s1",
      lastUnreadSeq: 2,
    }], {
      confirmedAccessScopes: [{ kind: "server", serverId: "s1" }],
    })

    expect(projection.projectUnread("servers", "c1", false)).toBe(false)
    expect(projection.projectUnread("servers", "c1", true, 2)).toBe(false)
    expect(projection.inspectForTests().sourceCount).toBe(0)
  })

  it("inherits a server retirement floor for channels learned behind its tombstone", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "known", serverId: "s1", seq: 1 })
    projection.retireAccessScope({ kind: "server", serverId: "s1" })

    projection.recordArrival({ channelId: "late", serverId: "s1", seq: 2 })
    projection.grantAccessScope({ kind: "server", serverId: "s1" })
    const empty = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(empty, [], {
      confirmedAccessScopes: [{ kind: "server", serverId: "s1" }],
    })

    expect(projection.projectUnread("inbox-unreads", "late", true, 2)).toBe(false)
    expect(projection.inspectForTests().sourceCount).toBe(0)
  })

  it("keeps a retired channel raw row fenced until a fresh snapshot confirms access", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "private", serverId: "s1", seq: 1 })
    projection.retireAccessScope({ kind: "channel", channelId: "private" })

    expect(projection.projectUnread("inbox-unreads", "private", true, 1)).toBe(false)
    projection.grantAccessScope({ kind: "channel", channelId: "private" })
    expect(projection.projectUnread("inbox-unreads", "private", true, 1)).toBe(false)

    const empty = projection.beginSnapshot("server-detail:s1", "channels")
    projection.absorbSnapshot(empty, [], {
      confirmedAccessScopes: [{ kind: "channel", channelId: "private" }],
    })
    expect(projection.projectUnread("inbox-unreads", "private", true, 1)).toBe(false)
    expect(projection.projectUnread("server-detail:s1", "private", true, 1)).toBe(false)

    const positive = projection.beginSnapshot("server-detail:s1", "channels")
    projection.absorbSnapshot(positive, [{
      channelId: "private",
      serverId: "s1",
      lastUnreadSeq: 2,
    }])
    expect(projection.projectUnread("server-detail:s1", "private", true, 2)).toBe(true)
  })

  it("releases abandoned snapshot tokens without accepting late evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    const token = projection.beginSnapshot("servers")
    expect(projection.inspectForTests().pendingSnapshots).toBe(1)
    projection.cancelSnapshot(token)
    projection.absorbSnapshot(token, [{ channelId: "late", lastUnreadSeq: 2 }])
    expect(projection.inspectForTests()).toMatchObject({
      pendingSnapshots: 0,
      sourceCount: 0,
    })
  })

  it("enriches duplicate exact rows from arrivals and canonical snapshot evidence", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "arrival", seq: 2 })
    projection.recordArrival({
      channelId: "arrival",
      serverId: "s1",
      railChannelId: "forum-1",
      seq: 2,
    })
    expect(projection.hasPending(undefined, "channels")).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "forum-1", [], false)).toBe(true)

    projection.recordArrival({ channelId: "snapshot", seq: 3 })
    const token = projection.beginSnapshot("inbox-mentions", "mentions")
    projection.absorbSnapshot(token, [{
      channelId: "snapshot",
      serverId: "s1",
      railChannelId: "forum-1",
      lastUnreadSeq: 3,
      lastMentionSeq: 3,
      isMention: true,
      attentionId: "attention-1",
    }], { truncated: true })

    expect(projection.projectUnread(
      "inbox-mentions", "snapshot", false, 3, "mentions", null, true, "attention-1",
    )).toBe(true)
    expect(projection.projectServerChannelUnread("s1", "forum-1", [], false)).toBe(true)
  })

  it("preserves authoritative server and channel bases beneath pending policy overlays", () => {
    const serverProjection = new AccountUnreadProjection("u1")
    serverProjection.setNotificationPolicy({ server: { s1: "mentions" } })
    const serverToken = serverProjection.beginNotificationPolicyOverlay({
      kind: "server",
      id: "s1",
      level: "nothing",
    })
    serverProjection.setNotificationPolicy({ server: { s1: "all" } })
    serverProjection.rollbackNotificationPolicyOverlay(serverToken)
    serverProjection.recordArrival({
      channelId: "c1", serverId: "s1", seq: 1, isMention: true,
    })
    expect(serverProjection.projectUnread("servers", "c1", false)).toBe(true)

    const channelProjection = new AccountUnreadProjection("u1")
    channelProjection.setNotificationPolicy({ channel: { c1: "mentions" } })
    const channelToken = channelProjection.beginNotificationPolicyOverlay({
      kind: "channel",
      id: "c1",
      level: "nothing",
    })
    channelProjection.setNotificationPolicy({ channel: { c1: "all" } })
    channelProjection.rollbackNotificationPolicyOverlay(channelToken)
    channelProjection.recordArrival({
      channelId: "c1", serverId: "s1", seq: 1, isMention: true,
    })
    expect(channelProjection.projectUnread("servers", "c1", false)).toBe(true)

    const absentChannelProjection = new AccountUnreadProjection("u1")
    absentChannelProjection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const absentToken = absentChannelProjection.beginNotificationPolicyOverlay({
      kind: "channel",
      id: "c1",
      level: "nothing",
    })
    expect(absentChannelProjection.projectUnread("servers", "c1", false)).toBe(false)
    absentChannelProjection.setNotificationPolicy({})
    expect(absentChannelProjection.projectUnread("servers", "c1", false)).toBe(false)
    absentChannelProjection.rollbackNotificationPolicyOverlay(absentToken)
    expect(absentChannelProjection.projectUnread("servers", "c1", false)).toBe(true)
  })

  it("matches identity-free attention dismissals by seq and ignores newer dismissals in counts", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.beginDismissMention({
      mentionId: "same-seq", channelId: "c1", seq: 4, countsServerMention: false,
    })
    expect(projection.projectUnread(
      "inbox-mentions", "c1", true, 4, "mentions", null, true,
    )).toBe(false)

    projection.beginDismissMention({
      mentionId: "future",
      channelId: "c1",
      seq: 5,
      countsServerMention: true,
    })
    expect(projection.projectMentionCount("servers", "c1", 1, 4)).toBe(1)
  })

  it("settles a confirmed mark-all fence after its captured source is read", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const markAll = projection.beginMarkAll("channels")
    projection.commitMarkAll(markAll, 1)
    projection.acceptPrimarySnapshot({ revision: 1, readStates: [] })
    projection.recordRead("c1", 1)

    const snapshot = projection.beginSnapshot("servers", "channels")
    projection.absorbSnapshot(snapshot, [])

    expect(projection.projectUnread("servers", "fresh", true, 2)).toBe(true)
  })

  it("keeps every public operation inert after disposal", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.dispose()
    const listener = vi.fn()
    projection.subscribe(listener)()
    projection.setReconcileScheduler(listener)
    projection.settleOptimisticRead(1, true, 1)
    projection.acceptPrimarySnapshot({ revision: 1, readStates: [] })
    projection.absorbFamily("servers", [{ channelId: "c1", lastUnreadSeq: 1 }])
    expect(projection.projectUnread("servers", "c1", true, 1)).toBe(false)
    expect(projection.projectMentionCount("servers", "c1", 1, 1)).toBe(0)

    const policy = projection.beginNotificationPolicyOverlay({
      kind: "server",
      id: "s1",
      level: "nothing",
    })
    projection.commitNotificationPolicyOverlay(policy)
    projection.rollbackNotificationPolicyOverlay(policy)
    const dismissal = projection.beginDismissMention({ mentionId: "m1", channelId: "c1" })
    projection.commitDismissMention(dismissal)
    projection.rollbackDismissMention(dismissal)
    const retirement = projection.beginScopeRetirement({ kind: "server", serverId: "s1" })
    projection.commitScopeRetirement(retirement)
    projection.rollbackScopeRetirement(retirement)
    projection.retireAccessScope({ kind: "server", serverId: "s1" })
    projection.grantAccessScope({ kind: "server", serverId: "s1" })
    projection.confirmAccessScopes(
      [{ kind: "server", serverId: "s1" }],
      projection.beginAccessConfirmation(),
    )
    const markAll = projection.beginMarkAll("channels")
    projection.commitMarkAll(markAll, 1)
    projection.rollbackMarkAll(markAll)
    projection.dispose()

    expect(listener).not.toHaveBeenCalled()
  })

  it("fences late snapshots and mutations after disposal", () => {
    const projection = new AccountUnreadProjection("u1")
    projection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    const snapshot = projection.beginSnapshot("servers")
    const scope = projection.beginScopeRetirement({ kind: "server", serverId: "s1" })
    projection.dispose()
    projection.absorbSnapshot(snapshot, [{ channelId: "late", lastUnreadSeq: 2 }])
    projection.rollbackScopeRetirement(scope)
    projection.recordArrival({ channelId: "late", seq: 2 })
    expect(projection.inspectForTests()).toMatchObject({ sourceCount: 0, disposed: true })
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
