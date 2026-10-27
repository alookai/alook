import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCanonicalMessagesById } from "@/lib/community-db/projections"
import * as projections from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { useMessage } from "../use-message"
import { dispatchCommunityWsEvent } from "../community-ws/registry"
import { getCommunityRuntime } from "@/stores/community/runtime"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient
function Probe({ messageId = "m1" }: { messageId?: string | null }) {
  const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient })
  const exact = useMessage(messageId), rows = useCanonicalMessagesById()
  return <><output data-testid="exact">{exact.message?.content ?? "missing"}</output><output data-testid="canonical">{rows?.get("m1")?.content ?? "missing"}</output></>
}
function Root({ id = sdk.id, messageId }: { id?: string; messageId?: string | null }) { return <QueryProvider userId={id}><Probe messageId={messageId} /></QueryProvider> }
async function mount() {
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; authenticationAccount: string; signal?: AbortSignal }) => {
    const key = `${options.authenticationAccount}:${path}`
    if (seen.has(key)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")), { once: true }))
    seen.add(key)
    return Promise.resolve({ id: "m1", channelId: "c1", seq: 1, type: "chat", content: "original", authorId: "peer", authorName: "Peer", authorAvatar: "", authorAvatarVersion: 0, createdAt: "2026-10-02T00:00:00Z" })
  })
  const view = render(<Root />)
  await waitFor(() => expect(screen.getByTestId("canonical").textContent).toBe("original"))
  return { view, original: client }
}
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset(); sdk.id = "A" })
describe("canonical message identity and reaction publication", () => {
  it("subscribes the exact message to its ID and selects no rows without an ID", async () => {
    const subscription = vi.spyOn(projections, "useCanonicalMessagesById")
    try {
      const { view } = await mount()
      expect(subscription).toHaveBeenCalledWith(["m1"])
      const requests = api.mock.calls.length
      subscription.mockClear()
      act(() => view.rerender(<Root messageId={null} />))
      expect(subscription).toHaveBeenCalledWith([])
      expect(screen.getByTestId("exact").textContent).toBe("missing")
      expect(screen.getByTestId("canonical").textContent).toBe("original")
      expect(api.mock.calls).toHaveLength(requests)
    } finally { subscription.mockRestore() }
  })
  it("WS reactions update canonical facts without overwriting the exact-message ID transport", async () => {
    const { original } = await mount(), runtime = getCommunityRuntime(original)
    act(() => dispatchCommunityWsEvent({ type: "community:reaction.add", messageId: "m1", channelId: "c1", emoji: "👍", userId: "peer" },
      { deliveryMode: "single", queryClient: original, communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: "A" }, matchesFocus: () => false }))
    expect(original.getQueryData(communityKeys.message("m1"))).toBe("m1")
    expect(getCommunityDbRegistry(original)!.collections.messages.get("m1")?.reactions).toMatchObject([{ emoji: "👍", userIds: ["peer"] }])
  })
})
