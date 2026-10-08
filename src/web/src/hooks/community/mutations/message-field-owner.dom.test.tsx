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
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { useMessage } from "../use-message"
import { useEditMessage } from "./messages"
import { dispatchCommunityWsEvent } from "../community-ws/registry"
import { getCommunityRuntime } from "@/stores/community/runtime"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient, edit: ReturnType<typeof useEditMessage>
function Probe({ messageId = "m1" }: { messageId?: string | null }) {
  const currentClient = useQueryClient(), command = useEditMessage(); useLayoutEffect(() => { client = currentClient; edit = command })
  const exact = useMessage(messageId), rows = useCanonicalMessagesById()
  return <><output data-testid="exact">{exact.message?.content ?? "missing"}</output><output data-testid="canonical">{rows?.get("m1")?.content ?? "missing"}</output></>
}
function Root({ id = sdk.id, messageId }: { id?: string; messageId?: string | null }) { return <QueryProvider userId={id}><Probe messageId={messageId} /></QueryProvider> }
const args = { serverId: "s1", channelId: "c1", messageId: "m1", content: "requested" }
async function mount() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const held = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; authenticationAccount: string; signal?: AbortSignal }) => {
    if (options.method === "PATCH") return held
    const key = `${options.authenticationAccount}:${path}`
    if (seen.has(key)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")), { once: true }))
    seen.add(key)
    return Promise.resolve({ id: "m1", channelId: "c1", seq: 1, type: "chat", content: "original", authorId: "peer", authorName: "Peer", authorAvatar: "", authorAvatarVersion: 0, createdAt: "2026-10-02T00:00:00Z" })
  })
  const view = render(<Root />)
  await waitFor(() => expect(screen.getByTestId("canonical").textContent).toBe("original"))
  return { view, resolve, reject, original: client }
}
function command() { return edit.mutateAsync(args).catch((error) => error) }
async function pending() { await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true)) }
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset(); sdk.id = "A" })
describe("actual canonical message field command", () => {
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
  it.each(["edit", "reaction"] as const)("WS %s updates canonical facts without overwriting the exact-message ID transport", async (kind) => {
    const { original } = await mount(), runtime = getCommunityRuntime(original)
    act(() => dispatchCommunityWsEvent(kind === "edit"
      ? { type: "community:message.edited", messageId: "m1", channelId: "c1", content: "newer-ws" }
      : { type: "community:reaction.add", messageId: "m1", channelId: "c1", emoji: "👍", userId: "peer" },
      { deliveryMode: "single", queryClient: original, communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: "A" }, matchesFocus: () => false, scheduleInboxInvalidate: vi.fn() }))
    expect(original.getQueryData(communityKeys.message("m1"))).toBe("m1")
    if (kind === "edit") expect(screen.getByTestId("exact").textContent).toBe("newer-ws")
    else expect(getCommunityDbRegistry(original)!.collections.messages.get("m1")?.reactions).toMatchObject([{ emoji: "👍", userIds: ["peer"] }])
  })
  it("shows native optimistic content in both consumers and commits HTTP success without self WS", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() })
    await pending()
    expect(screen.getByTestId("exact").textContent).toBe("requested")
    expect(getCommunityDbRegistry(original)!.collections.messages.get("m1")?.content).toBe("requested")
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(screen.getByTestId("canonical").textContent).toBe("requested")
    expect(original.getQueryData(communityKeys.message("m1"))).toBe("m1")
  })
  it.each(["success", "failure"] as const)("preserves newer WS content after command %s", async (outcome) => {
    const { resolve, reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    act(() => projectCommunityWsEventToDb(original, { type: "community:message.edited", messageId: "m1", channelId: "c1", serverId: "s1", content: "newer-ws" }))
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("denied")); await result })
    expect(screen.getByTestId("canonical").textContent).toBe("newer-ws")
    expect(screen.getByTestId("exact").textContent).toBe("newer-ws")
  })
  it("confirms content independently of a newer reaction event", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    act(() => projectCommunityWsEventToDb(original, { type: "community:reaction.add", messageId: "m1", channelId: "c1", emoji: "👍", userId: "peer" }))
    await act(async () => { resolve(undefined); await result })
    expect(screen.getByTestId("canonical").textContent).toBe("requested")
    expect(getCommunityDbRegistry(original)!.collections.messages.get("m1")?.reactions).toMatchObject([{ emoji: "👍", userIds: ["peer"] }])
  })
  it.each(["success", "failure"] as const)("rejects old account %s without recreating its caches", async (outcome) => {
    const { resolve, reject, original, view } = await mount()
    let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(client).not.toBe(original))
    await waitFor(() => expect(screen.getByTestId("canonical").textContent).toBe("original"))
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("old failure")); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(screen.getByTestId("canonical").textContent).toBe("original")
  })
})
