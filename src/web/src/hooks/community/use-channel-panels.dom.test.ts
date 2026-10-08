import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { usePins, useThreads } from "./use-channel-panels"
import { usePinMessage } from "./mutations/message-memberships"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { ingestMessages } from "@/lib/community-db/sync"
import * as projections from "@/lib/community-db/projections"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))

describe("usePins", () => {
  it("includes the same-channel pending pin in the bounded native message selection", async () => {
    const owner = await createCommunityQueryOwner("viewer")
    ingestMessages(owner.registry, "c1", [{ id: "pending", seq: 1, type: "chat", content: "Pinned body" }])
    ingestMessages(owner.registry, "foreign", [{ id: "foreign", seq: 1, type: "chat", content: "Foreign body" }])
    let resolve!: () => void
    api.mockReset().mockImplementation((_path: string, options: { method?: string }) => options.method === "POST"
      ? new Promise<void>((done) => { resolve = done }) : Promise.resolve({ pins: [] }))
    const subscription = vi.spyOn(projections, "useCanonicalMessagesById")
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, userId: "viewer", retainOwner: true }, children)
    const rendered = renderHook(() => ({ pins: usePins("c1"), pin: usePinMessage() }), { wrapper })
    try {
      await waitFor(() => expect(rendered.result.current.pins.isSuccess).toBe(true))
      expect(rendered.result.current.pins.pins).toEqual([])
      let request!: Promise<unknown>
      act(() => { request = rendered.result.current.pin.mutateAsync({ channelId: "c1", messageId: "pending" }) })
      await waitFor(() => expect(rendered.result.current.pins.pins.map((row) => row.id)).toEqual(["pending"]))
      expect(subscription).toHaveBeenCalledWith(["pending"])
      expect(owner.registry.collections.messages.size).toBe(2)
      expect(owner.registry.collections.messages.get("foreign")?.content).toBe("Foreign body")
      await act(async () => { resolve(); await request })
    } finally { rendered.unmount(); subscription.mockRestore() }
  })
  it("exposes a stable empty list while the query is disabled", async () => {
    const queryClient = new QueryClient()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => usePins(null), { wrapper })

    expect(rendered.result.current.pins).toEqual([])
    expect(renderHook(() => useThreads(null), { wrapper }).result.current.threads).toEqual([])
    const disabledPins = queryClient.getQueryCache().find({
      queryKey: communityKeys.pins("__none__"),
    })?.options.queryFn
    const disabledThreads = queryClient.getQueryCache().find({
      queryKey: communityKeys.threads("__none__"),
    })?.options.queryFn
    expect(disabledPins).toBeTypeOf("function")
    expect(disabledThreads).toBeTypeOf("function")
    await expect(disabledPins!({} as never)).rejects.toThrow("disabled")
    await expect(disabledThreads!({} as never)).rejects.toThrow("disabled")
    rendered.unmount()
  })
})
