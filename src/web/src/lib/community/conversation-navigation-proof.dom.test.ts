import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { QueryClient } from "@tanstack/react-query"
import {
  beginConversationNavigationProof,
  cancelActiveConversationNavigationProof,
  cancelConversationNavigationProof,
  commitConversationNavigationEntry,
  commitConversationNavigationProof,
  failConversationNavigationProof,
  getCompletedConversationNavigationEntryEpoch,
  getConversationNavigationProof,
  isCurrentConversationNavigation,
  recordConversationNavigationReceipt,
  recoverConversationNavigationProof,
  registerConversationNavigationRecovery,
  useConversationNavigationGate,
} from "./conversation-navigation-proof"

const target = {
  href: "/c/channels/s1/c1",
  viewerId: "viewer",
  channelId: "c1",
  serverId: "s1",
  scopeKind: "channel" as const,
  expectedSurfaceKind: "channel" as const,
}

describe("conversation navigation proof", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("aborts and fences A when B supersedes it", () => {
    const queryClient = new QueryClient()
    const a = beginConversationNavigationProof(queryClient, target, 3)
    const b = beginConversationNavigationProof(queryClient, {
      ...target,
      href: "/c/channels/s1/c2",
      channelId: "c2",
    }, 3)

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(isCurrentConversationNavigation(queryClient, a.epoch, 3)).toBe(false)
    expect(isCurrentConversationNavigation(queryClient, b.epoch, 3)).toBe(true)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      3,
      a.epoch,
    )).toBe(false)
    expect(getConversationNavigationProof(queryClient)).toMatchObject({
      epoch: b.epoch,
      status: "warming",
      target: { channelId: "c2" },
    })
  })

  it("accepts only a matching fresh canonical surface receipt", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 7)

    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "dm" },
      7,
      proof.epoch,
    )).toBe(false)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      8,
      proof.epoch,
    )).toBe(false)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      7,
      proof.epoch,
    )).toBe(true)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("verified")
    expect(commitConversationNavigationProof(queryClient, "c1", 7)).toBe(true)
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: null,
    }, 7)).toBe(proof.epoch)
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "wrong-anchor",
    }, 7)).toBeNull()
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: null,
    }, 8)).toBeNull()
    expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
  })

  it("does not expose completed ownership from a superseded intent", () => {
    const queryClient = new QueryClient()
    const first = beginConversationNavigationProof(queryClient, {
      ...target,
      anchorMessageId: "first-anchor",
    }, 4)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      4,
      first.epoch,
    )
    expect(commitConversationNavigationProof(queryClient, "c1", 4)).toBe(true)
    const second = beginConversationNavigationProof(queryClient, {
      ...target,
      href: "/c/channels/s1/c2?msg=second-anchor",
      channelId: "c2",
      anchorMessageId: "second-anchor",
    }, 4)

    expect(first.signal.aborted).toBe(true)
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "first-anchor",
    }, 4)).toBeNull()
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c2",
      scopeKind: "channel",
      anchorMessageId: "second-anchor",
    }, 4)).toBeNull()
    expect(second.signal.aborted).toBe(false)
  })

  it("reuses completed canonical ownership only for the exact identity, scope, anchor, and access epoch", () => {
    const queryClient = new QueryClient()
    const anchoredTarget = { ...target, anchorMessageId: "m-anchor" }
    expect(commitConversationNavigationEntry(queryClient, anchoredTarget, 4)).toBe(false)

    beginConversationNavigationProof(queryClient, {
      ...target,
      href: "/c/channels/s1/c2",
      channelId: "c2",
    }, 4)
    const revisit = beginConversationNavigationProof(queryClient, anchoredTarget, 4)
    expect(getConversationNavigationProof(queryClient)).toMatchObject({
      epoch: revisit.epoch,
      status: "proven",
      target: { channelId: "c1", anchorMessageId: "m-anchor" },
    })

    failConversationNavigationProof(queryClient, revisit.epoch, 4, false)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")

    beginConversationNavigationProof(queryClient, {
      ...anchoredTarget,
      anchorMessageId: "other-anchor",
    }, 4)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
    beginConversationNavigationProof(queryClient, {
      ...anchoredTarget,
      href: "/c/me/c1",
      serverId: undefined,
      scopeKind: "dm",
      expectedSurfaceKind: "dm",
    }, 4)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
    beginConversationNavigationProof(queryClient, {
      ...anchoredTarget,
      viewerId: "other-viewer",
    }, 4)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
    beginConversationNavigationProof(queryClient, anchoredTarget, 5)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
  })

  it("reuses an exact covered anchor from the active completed base entry without making it a wildcard", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 4)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      4,
      proof.epoch,
    )
    expect(commitConversationNavigationEntry(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-anchor",
    }, 4)).toBe(false)

    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-anchor",
    }, 4)).toBe(proof.epoch)
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "missing-anchor",
    }, 4)).toBeNull()
  })

  it("keeps an exact covered anchor readable after the active proof is consumed", async () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 4)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      4,
      proof.epoch,
    )
    commitConversationNavigationEntry(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-after-consume",
    }, 4)

    function Gate() {
      useConversationNavigationGate(queryClient, "viewer", "c1", 4)
      return null
    }

    const renderer = render(createElement(Gate))
    expect(getConversationNavigationProof(queryClient)).toBeNull()
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-after-consume",
    }, 4)).toBe(proof.epoch)
    await act(async () => renderer.unmount())
  })

  it("does not expose a consumed covered anchor after another identity supersedes it", async () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 4)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      4,
      proof.epoch,
    )
    commitConversationNavigationEntry(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-before-supersede",
    }, 4)

    function Gate() {
      useConversationNavigationGate(queryClient, "viewer", "c1", 4)
      return null
    }

    const renderer = render(createElement(Gate))
    beginConversationNavigationProof(queryClient, {
      ...target,
      href: "/c/channels/s1/c2",
      channelId: "c2",
    }, 4)
    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-before-supersede",
    }, 4)).toBeNull()
    await act(async () => renderer.unmount())
  })

  it("rejects covered anchors across access epochs and after definitive denial", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 4)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      4,
      proof.epoch,
    )
    commitConversationNavigationEntry(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-before-denial",
    }, 4)

    expect(getCompletedConversationNavigationEntryEpoch(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-before-denial",
    }, 5)).toBeNull()
    failConversationNavigationProof(queryClient, proof.epoch, 4, true)
    beginConversationNavigationProof(queryClient, {
      ...target,
      anchorMessageId: "covered-before-denial",
    }, 4)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
  })

  it("accepts forum authority, ignores duplicate receipts, and rejects wrong targets", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 2)

    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "other", surfaceKind: "forum" },
      2,
      proof.epoch,
    )).toBe(false)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      2,
      proof.epoch,
    )).toBe(true)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      2,
      proof.epoch,
    )).toBe(true)
    expect(commitConversationNavigationProof(queryClient, "c1", 2)).toBe(false)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("forum")
  })

  it("supports DM supersession and exact active-proof cancellation", async () => {
    const queryClient = new QueryClient()
    const dmTarget = {
      ...target,
      href: "/c/me/d1",
      channelId: "d1",
      serverId: undefined,
      scopeKind: "dm" as const,
      expectedSurfaceKind: "dm" as const,
    }
    const first = beginConversationNavigationProof(queryClient, dmTarget, 1)
    expect(cancelActiveConversationNavigationProof(new QueryClient())).toBe(false)
    expect(cancelConversationNavigationProof(queryClient, first.epoch + 1)).toBeUndefined()
    expect(cancelActiveConversationNavigationProof(queryClient)).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(getConversationNavigationProof(queryClient)).toBeNull()
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "d1", surfaceKind: "dm" },
      1,
      first.epoch,
    )).toBe(false)
  })

  it("aborts the prior DM proof when a new proof supersedes it", async () => {
    const queryClient = new QueryClient()
    const dmTarget = {
      ...target,
      href: "/c/me/d1",
      channelId: "d1",
      serverId: undefined,
      scopeKind: "dm" as const,
      expectedSurfaceKind: "dm" as const,
    }
    const first = beginConversationNavigationProof(queryClient, dmTarget, 1)
    const second = beginConversationNavigationProof(queryClient, target, 1)

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(getConversationNavigationProof(queryClient)?.target).toEqual(target)
  })

  it("cannot reuse an Inbox proof after ordinary navigation supersedes it", () => {
    const queryClient = new QueryClient()
    const inboxA = beginConversationNavigationProof(queryClient, target, 4)
    expect(cancelActiveConversationNavigationProof(queryClient)).toBe(true)
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      4,
      inboxA.epoch,
    )).toBe(false)
    expect(getConversationNavigationProof(queryClient)).toBeNull()
  })

  it("registers and fences recovery by proof epoch", () => {
    const queryClient = new QueryClient()
    const first = beginConversationNavigationProof(queryClient, target, 3)
    const restart = vi.fn()
    expect(registerConversationNavigationRecovery(
      queryClient,
      first.epoch + 1,
      restart,
    )).toBe(false)
    expect(registerConversationNavigationRecovery(queryClient, first.epoch, restart)).toBe(true)
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 3)).toBe(false)

    failConversationNavigationProof(queryClient, first.epoch + 1, 3, false)
    failConversationNavigationProof(queryClient, first.epoch, 3, false)
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 3)).toBe(true)
    expect(restart).toHaveBeenCalledWith(3, 1)

    const second = beginConversationNavigationProof(queryClient, target, 4, 1)
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 4)).toBe(false)
    expect(registerConversationNavigationRecovery(queryClient, second.epoch, restart)).toBe(true)
    expect(recoverConversationNavigationProof(queryClient, second.epoch, 5)).toBe(true)
    expect(restart).toHaveBeenLastCalledWith(5, 0)
  })

  it("makes definitive denial terminal and clears recovery", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 6)
    const restart = vi.fn()
    registerConversationNavigationRecovery(queryClient, proof.epoch, restart)
    failConversationNavigationProof(queryClient, proof.epoch, 6, true)

    expect(proof.signal.aborted).toBe(true)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    expect(recoverConversationNavigationProof(queryClient, proof.epoch, 7)).toBe(false)
    expect(restart).not.toHaveBeenCalled()
  })

  it("clears covered anchors for the denied conversation scope", () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 6)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "forum" },
      6,
      proof.epoch,
    )
    commitConversationNavigationEntry(queryClient, {
      viewerId: "viewer",
      channelId: "c1",
      scopeKind: "channel",
      anchorMessageId: "covered-before-denial",
    }, 6)

    failConversationNavigationProof(queryClient, proof.epoch, 6, true)
    beginConversationNavigationProof(queryClient, {
      ...target,
      anchorMessageId: "covered-before-denial",
    }, 6)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("warming")
  })

  it("recovers access drift immediately and transient failure after bounded backoff", async () => {
    vi.useFakeTimers()
    const queryClient = new QueryClient()
    const restart = vi.fn()
    const proof = beginConversationNavigationProof(queryClient, target, 7)
    registerConversationNavigationRecovery(queryClient, proof.epoch, restart)
    let latestGate: { required: boolean; allowed: boolean } | undefined

    function Gate({ accessEpoch }: { accessEpoch: number }) {
      latestGate = useConversationNavigationGate(queryClient, "viewer", "c1", accessEpoch)
      return null
    }

    const renderer = render(createElement(Gate, { accessEpoch: 8 }))
    expect(latestGate).toEqual({ required: true, allowed: false })
    expect(restart).toHaveBeenCalledWith(8, 0)

    const retry = beginConversationNavigationProof(queryClient, target, 8, 2)
    registerConversationNavigationRecovery(queryClient, retry.epoch, restart)
    failConversationNavigationProof(queryClient, retry.epoch, 8, false)
    await act(async () => {
      renderer.rerender(createElement(Gate, { accessEpoch: 8 }))
    })
    expect(restart).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(999)
    })
    expect(restart).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(restart).toHaveBeenLastCalledWith(8, 3)
    await act(async () => renderer.unmount())
  })

  it("consumes successful proof after the first authorized paint", async () => {
    const queryClient = new QueryClient()
    const proof = beginConversationNavigationProof(queryClient, target, 9)
    recordConversationNavigationReceipt(
      queryClient,
      { channelId: "c1", surfaceKind: "channel" },
      9,
      proof.epoch,
    )
    commitConversationNavigationProof(queryClient, "c1", 9)
    const gates: Array<{ required: boolean; allowed: boolean }> = []

    function Gate() {
      gates.push(useConversationNavigationGate(queryClient, "viewer", "c1", 9))
      return null
    }

    const renderer = render(createElement(Gate))
    expect(gates).toContainEqual({ required: true, allowed: true })
    expect(getConversationNavigationProof(queryClient)).toBeNull()
    await act(async () => renderer.unmount())
  })

  it("keeps the server snapshot proof-free", () => {
    const queryClient = new QueryClient()

    function Gate() {
      const gate = useConversationNavigationGate(queryClient, "viewer", "c1", 1)
      return createElement("span", null, `${gate.required}:${gate.allowed}`)
    }

    expect(renderToString(createElement(Gate))).toContain("false:true")
  })
})
