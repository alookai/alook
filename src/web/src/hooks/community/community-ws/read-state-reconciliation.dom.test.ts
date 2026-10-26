import { createElement, type PropsWithChildren } from "react"
import { expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { disposeAccountReadStateReconciliation, useAccountReadState } from "./read-state-reconciliation"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

it("lets the native shell observer retry quiet failures and stops its HTTP after owner retirement", async () => {
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: 3 } } })
  vi.useFakeTimers()
  let requests = 0
  apiFetch.mockImplementation(async () => {
    requests += 1
    if (requests <= 4) throw new Error("offline")
    return { revision: 8, readStates: [{ channelId: "c1", lastReadMessageId: "m8", lastReadAt: "2026-10-27T00:00:08.000Z", lastReadSeq: 8 }] }
  })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const rendered = renderHook(useAccountReadState, { wrapper })
  const original = owner.client.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(owner.registry.collections.readStates.get("c1")?.lastReadSeq).toBe(8)
    expect(owner.client.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })).toBe(original)
    disposeAccountReadStateReconciliation(owner.client)
    const before = requests
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(requests).toBe(before)
  } finally { rendered.unmount(); await owner.client.cancelQueries(); vi.useRealTimers() }
})
