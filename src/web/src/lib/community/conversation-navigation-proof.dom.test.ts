import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { QueryClient } from "@tanstack/react-query"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import {
  beginConversationNavigationProof,
  cancelActiveConversationNavigationProof,
  cancelConversationNavigationProof,
  commitConversationNavigationProof,
  failConversationNavigationProof,
  getConversationNavigationProof,
  isCurrentConversationNavigation,
  recordConversationNavigationReceipt,
  recoverConversationNavigationProof,
  registerConversationNavigationRecovery,
  useConversationNavigationGate,
} from "./conversation-navigation-proof"

const owners: CommunityDbRegistry[] = []
function createClient() {
  const client = new QueryClient()
  owners.push(createCommunityDbRegistry(client, "viewer"))
  return client
}

const target = {
  href: "/c/channels/s1/c1",
  viewerId: "viewer",
  channelId: "c1",
  serverId: "s1",
  scopeKind: "channel" as const,
  expectedSurfaceKind: "channel" as const,
}

describe("conversation navigation proof", () => {
  afterEach(async () => {
    await act(async () => {
      vi.useRealTimers()
      for (const owner of owners.splice(0)) { await owner.cleanup(); owner.queryClient.clear() }
    })
  })

  it("rejects a foreign viewer without superseding the original intent", () => {
    const queryClient = createClient()
    const original = beginConversationNavigationProof(queryClient, target, 1)
    expect(() => beginConversationNavigationProof(queryClient, { ...target, viewerId: "foreign" }, 1)).toThrow("Conversation viewer does not match owner")
    expect(original.signal.aborted).toBe(false)
    expect(isCurrentConversationNavigation(queryClient, original.epoch, 1)).toBe(true)
  })

  it("aborts and fences A when B supersedes it", () => {
    const queryClient = createClient()
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
    const queryClient = createClient()
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
    expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
  })

  it("accepts forum authority, ignores duplicate receipts, and rejects wrong targets", () => {
    const queryClient = createClient()
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
    const queryClient = createClient()
    const cancel = vi.spyOn(queryClient, "cancelQueries")
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
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({
      queryKey: communityKeys.dmMessages("d1"),
    }))
    expect(first.signal.aborted).toBe(true)
    expect(getConversationNavigationProof(queryClient)).toBeNull()
    expect(recordConversationNavigationReceipt(
      queryClient,
      { channelId: "d1", surfaceKind: "dm" },
      1,
      first.epoch,
    )).toBe(false)
  })

  it("cancels the prior DM query when a new proof supersedes it", async () => {
    const queryClient = createClient()
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const dmTarget = {
      ...target,
      href: "/c/me/d1",
      channelId: "d1",
      serverId: undefined,
      scopeKind: "dm" as const,
      expectedSurfaceKind: "dm" as const,
    }
    await act(async () => { beginConversationNavigationProof(queryClient, dmTarget, 1) })
    await act(async () => { beginConversationNavigationProof(queryClient, target, 1) })

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({
      queryKey: communityKeys.dmMessages("d1"),
    }))
  })

  it("cannot reuse an Inbox proof after ordinary navigation supersedes it", () => {
    const queryClient = createClient()
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

  it("registers and fences recovery by proof epoch", async () => {
    const queryClient = createClient()
    const first = beginConversationNavigationProof(queryClient, target, 3)
    const restart = vi.fn()
    expect(registerConversationNavigationRecovery(
      queryClient,
      first.epoch + 1,
      restart,
    )).toBe(false)
    expect(registerConversationNavigationRecovery(queryClient, first.epoch, restart)).toBe(true)
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 3)).toBe(false)

    await act(async () => { failConversationNavigationProof(queryClient, first.epoch + 1, 3, false) })
    await act(async () => { failConversationNavigationProof(queryClient, first.epoch, 3, false) })
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 3)).toBe(true)
    expect(restart).toHaveBeenCalledWith(3, 1)

    const second = beginConversationNavigationProof(queryClient, target, 4, 1)
    expect(recoverConversationNavigationProof(queryClient, first.epoch, 4)).toBe(false)
    expect(registerConversationNavigationRecovery(queryClient, second.epoch, restart)).toBe(true)
    expect(recoverConversationNavigationProof(queryClient, second.epoch, 5)).toBe(true)
    expect(restart).toHaveBeenLastCalledWith(5, 0)
  })

  it("makes definitive denial terminal and clears recovery", async () => {
    const queryClient = createClient()
    const proof = beginConversationNavigationProof(queryClient, target, 6)
    const restart = vi.fn()
    registerConversationNavigationRecovery(queryClient, proof.epoch, restart)
    await act(async () => { failConversationNavigationProof(queryClient, proof.epoch, 6, true) })

    expect(proof.signal.aborted).toBe(true)
    expect(getConversationNavigationProof(queryClient)?.status).toBe("denied")
    expect(recoverConversationNavigationProof(queryClient, proof.epoch, 7)).toBe(false)
    expect(restart).not.toHaveBeenCalled()
  })

  it("recovers access drift immediately and transient failure after bounded backoff", async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    const restart = vi.fn()
    const proof = beginConversationNavigationProof(queryClient, target, 7)
    registerConversationNavigationRecovery(queryClient, proof.epoch, restart)
    let latestGate: { required: boolean; allowed: boolean } | undefined

    function Gate({ accessEpoch }: { accessEpoch: number }) {
      latestGate = useConversationNavigationGate(queryClient, "viewer", "c1", accessEpoch)
      return null
    }

    const renderer = render(createElement(Gate, { accessEpoch: 8 }))
    expect(latestGate).toMatchObject({ required: true, allowed: false })
    expect(restart).toHaveBeenCalledWith(8, 0)

    let retry!: ReturnType<typeof beginConversationNavigationProof>
    await act(async () => {
      retry = beginConversationNavigationProof(queryClient, target, 8, 2)
      registerConversationNavigationRecovery(queryClient, retry.epoch, restart)
    })
    await act(async () => { failConversationNavigationProof(queryClient, retry.epoch, 8, false) })
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
    const queryClient = createClient()
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
    expect(gates).toContainEqual(expect.objectContaining({ required: true, allowed: true }))
    expect(getConversationNavigationProof(queryClient)).toBeNull()
    await act(async () => renderer.unmount())
  })

  it("keeps the server snapshot proof-free", () => {
    const queryClient = createClient()

    function Gate() {
      const gate = useConversationNavigationGate(queryClient, "viewer", "c1", 1)
      return createElement("span", null, `${gate.required}:${gate.allowed}`)
    }

    expect(renderToString(createElement(Gate))).toContain("false:true")
  })
  it("keeps a message timeout failed until manual retry and refuses retry after retirement", async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    const proof = beginConversationNavigationProof(queryClient, target, 1)
    const restart = vi.fn()
    registerConversationNavigationRecovery(queryClient, proof.epoch, restart)
    failConversationNavigationProof(queryClient, proof.epoch, 1, false, true)
    let gate!: ReturnType<typeof useConversationNavigationGate>
    function Gate() { gate = useConversationNavigationGate(queryClient, "viewer", "c1", 1); return null }
    const view = render(createElement(Gate))
    expect(gate).toMatchObject({ required: true, allowed: false, failed: true })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(restart).not.toHaveBeenCalled()
    act(() => gate.retry())
    expect(restart).toHaveBeenCalledExactlyOnceWith(1, 1)
    cancelActiveConversationNavigationProof(queryClient)
    act(() => gate.retry())
    expect(restart).toHaveBeenCalledOnce()
    view.unmount()
  })

})
