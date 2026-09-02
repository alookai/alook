import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import {
  beginConversationNavigationProof,
  commitConversationNavigationProof,
  getConversationNavigationProof,
  isCurrentConversationNavigation,
  recordConversationNavigationReceipt,
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
    expect(getConversationNavigationProof(queryClient)?.status).toBe("proven")
  })
})
