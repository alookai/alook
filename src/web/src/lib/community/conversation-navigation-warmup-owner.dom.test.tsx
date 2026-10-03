import React, { StrictMode, useLayoutEffect } from "react"
import { QueryClient, useInfiniteQuery } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { createQueryClient } from "@/lib/query-client"
import { communityKeys } from "@/lib/query-keys"
import { apiFetch } from "@/lib/api/client"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"
import { getConversationNavigationProof, recoverConversationNavigationProof, useConversationNavigationGate } from "./conversation-navigation-proof"
import { channelMessagesQueryFn, dmMessagesQueryFn } from "@/hooks/community/use-messages"
import type { MessagesPageParam } from "@/lib/community/models/message"

vi.mock("@/lib/api/client", async (load) => {
  const actual = await load<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: vi.fn(actual.apiFetch) }
})


const owners: CommunityDbRegistry[] = []
const target = { href: "/c/me/d1", viewerId: "viewer", channelId: "d1", scopeKind: "dm" as const }
const readKey = communityKeys.dmReadStateSnapshot("d1")
let releases: Array<(response: Response) => void>
let assign: ReturnType<typeof vi.fn>
const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")
let signals: AbortSignal[]
beforeEach(() => {
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
  releases = []
  signals = []
  vi.mocked(apiFetch).mockClear()
  assign = vi.fn()
  const actualWindow = window
  vi.stubGlobal("window", new Proxy(actualWindow, { get(object, key) {
    if (key === "location") return { origin: "https://alook.test", assign }
    return Reflect.get(object, key, object)
  } }))
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
    if (path.includes("/messages")) return Promise.resolve(new Response(JSON.stringify({ messages: [], hasMore: false, surfaceReceipt: { channelId: "d1", surfaceKind: "dm" } }), { status: 200, headers: { "Content-Type": "application/json" } }))
    signals.push(options.signal!)
    return new Promise<Response>((resolve) => releases.push(resolve))
  }))
})
afterEach(async () => {
  await act(async () => {
    for (const owner of owners.splice(0)) { await owner.cleanup(); owner.queryClient.clear() }
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor)
    else Reflect.deleteProperty(AbortSignal, "any")
    vi.unstubAllGlobals()
  })
})
function createClient() {
  const client = createQueryClient()
  const registry = createCommunityDbRegistry(client, "viewer")
  owners.push(registry)
  return { client, registry, unregister: registerCommunityDbRegistry(registry) }
}
function Gate({ client }: { client: QueryClient }) {
  useConversationNavigationGate(client, "viewer", "d1", 0)
  return null
}
function response(status: number) {
  return new Response(JSON.stringify(status === 200
    ? { lastReadMessageId: "read", lastReadAt: null, lastReadSeq: 5 }
    : { error: "denied" }), { status, headers: { "Content-Type": "application/json" } })
}

describe("warmup original owner and complete intent resources", () => {
  it.each(["channel", "thread", "forum", "dm"].flatMap((kind) =>
    ["anchor", "older"].map((mode) => ({ kind, mode })),
  ))("reads the current click after retained $mode pages on $kind", async ({ kind, mode }) => {
    const owner = createClient()
    await owner.registry.preload()
    const navigation = { ...target, scopeKind: kind === "dm" ? "dm" as const : "channel" as const,
      expectedSurfaceKind: kind as "channel" | "thread" | "forum" | "dm" }
    const key = kind === "dm" ? communityKeys.dmMessages("d1") : communityKeys.channelMessages("d1")
    owner.client.setQueryDefaults(key, { retry: false })
    const oldParam: MessagesPageParam = mode === "anchor"
      ? { mode: "anchor", anchor: "old-anchor" } : { mode: "older", cursor: "old-cursor" }
    const retained = { pages: [{ messages: [], hasMore: true }, { messages: [], hasMore: false }],
      pageParams: [oldParam, { mode: "older", cursor: "old-second-cursor" } as MessagesPageParam] }
    owner.client.setQueryData(key, retained)
    const requests: Array<{ path: string; resolve: (value: Response) => void }> = []
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (!path.includes("/messages")) return Promise.resolve(response(200))
      return new Promise<Response>((resolve) => requests.push({ path, resolve }))
    }))
    for (const anchorMessageId of ["current-marked-message", undefined]) {
      const previousCount = requests.length
      const epoch = startConversationNavigationWarmup(owner.client, { ...navigation, anchorMessageId }, 0)
      await waitFor(() => expect(requests).toHaveLength(previousCount + 1))
      const request = requests[previousCount]!
      const url = new URL(request.path, "https://alook.test")
      expect(url.searchParams.get("anchor")).toBe(anchorMessageId ?? null)
      expect(url.searchParams.has("cursor")).toBe(false)
      expect(owner.client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(previousCount === 0 ? 2 : 1)
      await act(async () => request.resolve(new Response(JSON.stringify({
        messages: [], hasMore: true, surfaceReceipt: { channelId: "d1", surfaceKind: kind },
      }), { status: 200, headers: { "Content-Type": "application/json" } })))
      await waitFor(() => expect(getConversationNavigationProof(owner.client)).toMatchObject({ epoch, status: kind === "forum" ? "forum" : "proven" }))
      await waitFor(() => expect(owner.client.getQueryCache().find({ queryKey: key, exact: true })!.getObserversCount()).toBe(0))
      expect(requests).toHaveLength(previousCount + 1)
      expect(owner.client.getQueryData(key)).toMatchObject({ pages: [{ messages: [] }],
        pageParams: [anchorMessageId ? { mode: "anchor", anchor: anchorMessageId } : { mode: "newest" }] })
    }
  })

  it.each(["channel", "thread", "forum", "dm"] as const)("keeps the click-owned %s transport alive after its prior visible body unmounts", async (surfaceKind) => {
    const owner = createClient()
    await owner.registry.preload()
    const navigation = { ...target, anchorMessageId: "marked-message",
      scopeKind: surfaceKind === "dm" ? "dm" as const : "channel" as const, expectedSurfaceKind: surfaceKind }
    const key = surfaceKind === "dm" ? communityKeys.dmMessages("d1") : communityKeys.channelMessages("d1")
    const messageRequests: Array<{ signal: AbortSignal; resolve: (value: Response) => void; path: string }> = []
    vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
      if (!path.includes("/messages")) return Promise.resolve(response(200))
      return new Promise<Response>((resolve) => messageRequests.push({ signal: options.signal!, resolve, path }))
    }))
    const bodyQueryFn = surfaceKind === "dm"
      ? dmMessagesQueryFn("d1", { queryClient: owner.client })
      : channelMessagesQueryFn("d1", null, { queryClient: owner.client })
    function Body() {
      const query = useInfiniteQuery({ queryKey: key, queryFn: bodyQueryFn,
        initialPageParam: { mode: "newest" } as MessagesPageParam, getNextPageParam: () => undefined,
        staleTime: Infinity, retry: false })
      return <p>{query.isSuccess ? "Current target body" : "Original pending body"}</p>
    }
    function Surface() {
      const gate = useConversationNavigationGate(owner.client, "viewer", "d1", 0)
      return gate.allowed ? <Body /> : <p>{gate.failed ? "Manual Retry" : "Warming target"}</p>
    }
    const mounted = render(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner><Surface /></CommunityTestProvider>)
    await waitFor(() => expect(messageRequests).toHaveLength(1))
    act(() => { startConversationNavigationWarmup(owner.client, navigation, 0) })
    await waitFor(() => expect(messageRequests).toHaveLength(2))
    expect(mounted.getByText("Warming target")).toBeTruthy()
    const resource = owner.client.getQueryCache().find({ queryKey: key, exact: true })!
    await waitFor(() => expect(resource.getObserversCount()).toBe(1))
    expect(resource.isActive()).toBe(false)
    expect(messageRequests[0]!.signal.aborted).toBe(true)
    expect(messageRequests[1]!.signal.aborted).toBe(false)
    expect(messageRequests[1]!.path).toContain("anchor=marked-message")
    await act(async () => messageRequests[1]!.resolve(new Response(JSON.stringify({
      messages: [], hasMore: false, surfaceReceipt: { channelId: "d1", surfaceKind },
    }), { status: 200, headers: { "Content-Type": "application/json" } })))
    await waitFor(() => expect(mounted.getByText("Current target body")).toBeTruthy())
    await waitFor(() => expect(getConversationNavigationProof(owner.client)).toBeNull())
    expect(resource.getObserversCount()).toBe(1)
    expect(resource.isActive()).toBe(true)
    expect(messageRequests).toHaveLength(2)
    mounted.unmount()
    expect(resource.getObserversCount()).toBe(0)
  })

  it.each(["cancel", "failure", "owner"] as const)("releases the original warmup message lease after %s settlement", async (settlement) => {
    const owner = createClient()
    await owner.registry.preload()
    owner.client.setQueryDefaults(communityKeys.dmMessages("d1"), { retry: false })
    let finish!: (value: Response) => void
    let messageSignal!: AbortSignal
    vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
      if (!path.includes("/messages")) return Promise.resolve(response(200))
      messageSignal = options.signal!
      return new Promise<Response>((resolve) => { finish = resolve })
    }))
    const epoch = startConversationNavigationWarmup(owner.client, target, 0)
    await waitFor(() => expect(messageSignal).toBeDefined())
    const resource = owner.client.getQueryCache().find({ queryKey: communityKeys.dmMessages("d1"), exact: true })!
    expect(resource.getObserversCount()).toBe(1)
    if (settlement === "cancel") {
      const { cancelConversationNavigationProof } = await import("./conversation-navigation-proof")
      cancelConversationNavigationProof(owner.client, epoch)
    } else if (settlement === "owner") owner.unregister()
    else finish(new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } }))
    if (settlement === "failure") {
      await waitFor(() => expect(getConversationNavigationProof(owner.client)).toMatchObject({ status: "failed", manualRetry: true }), { timeout: 5_000 })
    }
    await waitFor(() => expect(resource.getObserversCount()).toBe(0))
    if (settlement !== "failure") expect(messageSignal.aborted).toBe(true)
  })

  it("keeps a repeated same-target click alive after the old lease and late unauthorized response settle", async () => {
    const owner = createClient()
    await owner.registry.preload()
    const messageRequests: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = []
    vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
      if (!path.includes("/messages")) return Promise.resolve(response(200))
      return new Promise<Response>((resolve) => messageRequests.push({ signal: options.signal!, resolve }))
    }))
    startConversationNavigationWarmup(owner.client, { ...target, anchorMessageId: "first" }, 0)
    await waitFor(() => expect(messageRequests).toHaveLength(1))
    const epoch = startConversationNavigationWarmup(owner.client, { ...target, anchorMessageId: "second" }, 0)
    await waitFor(() => expect(messageRequests).toHaveLength(2))
    const resource = owner.client.getQueryCache().find({ queryKey: communityKeys.dmMessages("d1"), exact: true })!
    await waitFor(() => expect(resource.getObserversCount()).toBe(1))
    expect(messageRequests[0]!.signal.aborted).toBe(true)
    expect(messageRequests[1]!.signal.aborted).toBe(false)
    await act(async () => messageRequests[0]!.resolve(response(401)))
    expect(assign).not.toHaveBeenCalled()
    expect(getConversationNavigationProof(owner.client)).toMatchObject({ epoch, status: "warming", target: { anchorMessageId: "second" } })
    await act(async () => messageRequests[1]!.resolve(new Response(JSON.stringify({
      messages: [], hasMore: false, surfaceReceipt: { channelId: "d1", surfaceKind: "dm" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })))
    await waitFor(() => expect(getConversationNavigationProof(owner.client)).toMatchObject({ epoch, status: "proven" }))
    await waitFor(() => expect(resource.getObserversCount()).toBe(0))
    expect(messageRequests).toHaveLength(2)
  })

  it.each(["channel", "thread", "forum", "dm"] as const)("ends persistent %s 503 with manual Retry after finite Query retries", async (surfaceKind) => {
    const owner = createClient()
    await owner.registry.preload()
    const defaults = owner.client.getDefaultOptions()
    owner.client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: 1, retryDelay: 0 } })
    let failing = true
    let requests = 0
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (path.includes("/messages")) {
        requests++
        return Promise.resolve(new Response(JSON.stringify(failing ? { error: "unavailable" } : { messages: [], hasMore: false, surfaceReceipt: { channelId: "d1", surfaceKind } }), { status: failing ? 503 : 200, headers: { "Content-Type": "application/json" } }))
      }
      return Promise.resolve(response(200))
    }))
    const navigation = { ...target, scopeKind: surfaceKind === "dm" ? "dm" as const : "channel" as const, expectedSurfaceKind: surfaceKind }
    const epoch = startConversationNavigationWarmup(owner.client, navigation, 0)
    const rendered = render(<Gate client={owner.client} />)
    await waitFor(() => expect(getConversationNavigationProof(owner.client)).toMatchObject({ status: "failed", manualRetry: true }))
    expect(requests).toBe(2)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    expect(requests).toBe(2)
    failing = false
    act(() => { expect(recoverConversationNavigationProof(owner.client, epoch, 0)).toBe(true) })
    await waitFor(() => expect(getConversationNavigationProof(owner.client)).toBeNull())
    expect(requests).toBe(3)
    rendered.unmount()
  })

  it.each([401, 403, 200].flatMap((status) => [false, true].map((consume) => ({ status, consume }))))("retired owner late $status stays silent, consumed=$consume", async ({ status, consume }) => {
    const owner = createClient()
    startConversationNavigationWarmup(owner.client, target, 0)
    await waitFor(() => expect(releases).toHaveLength(1))
    await waitFor(() => expect(getConversationNavigationProof(owner.client)?.status).toBe("proven"))
    const mounted = consume ? render(<Gate client={owner.client} />) : null
    expect(getConversationNavigationProof(owner.client)?.status ?? null).toBe(consume ? null : "proven")
    expect(signals[0].aborted).toBe(false)
    const readCall = vi.mocked(apiFetch).mock.calls.findIndex(([path]) => path.endsWith("/read-state"))
    const request = vi.mocked(apiFetch).mock.results[readCall].value as Promise<unknown>
    const settled = request.catch((error: unknown) => error)
    owner.unregister()
    expect(signals[0].aborted).toBe(true)
    releases[0](response(status))
    expect(await settled).toMatchObject({ name: "AbortError" })
    expect(assign).not.toHaveBeenCalled()
    expect(owner.client.getQueryData(readKey)).toBeUndefined()
    expect(getConversationNavigationProof(owner.client)).toBeNull()
    act(() => mounted?.unmount())
  })

  it.each([401, 403, 200])("current owner late %i retains ordinary behavior", async (status) => {
    const owner = createClient()
    startConversationNavigationWarmup(owner.client, target, 0)
    await waitFor(() => expect(releases).toHaveLength(1))
    await waitFor(() => expect(getConversationNavigationProof(owner.client)?.status).toBe("proven"))
    const mounted = render(<Gate client={owner.client} />)
    const readCall = vi.mocked(apiFetch).mock.calls.findIndex(([path]) => path.endsWith("/read-state"))
    const request = vi.mocked(apiFetch).mock.results[readCall].value as Promise<unknown>
    const settled = request.catch((error: unknown) => error)
    releases[0](response(status))
    const result = await settled
    await waitFor(() => expect(owner.client.getQueryState(readKey)?.fetchStatus).toBe("idle"))
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
    if (status !== 200) {
      expect(result).toMatchObject({ status })
      expect(owner.client.getQueryState(readKey)?.error).toMatchObject({ status })
      expect(assign).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
    } else {
      await waitFor(() => expect(owner.client.getQueryData(readKey)).toMatchObject({ lastReadSeq: 5 }))
      expect(assign).not.toHaveBeenCalled()
    }
    act(() => mounted.unmount())
  })

  it("Strict replay starts current read, succeeds, and final owner exit clears consumed intent", async () => {
    const owner = createClient()
    function Warmup() {
      useLayoutEffect(() => { startConversationNavigationWarmup(owner.client, target, 0) }, [])
      return <Gate client={owner.client} />
    }
    const mounted = render(<StrictMode><CommunityTestProvider client={owner.client}><Warmup /></CommunityTestProvider></StrictMode>)
    await waitFor(() => expect(releases).toHaveLength(1))
    releases[0](response(200))
    await waitFor(() => expect(owner.client.getQueryData(readKey)).toMatchObject({ lastReadSeq: 5 }))
    await waitFor(() => expect(getConversationNavigationProof(owner.client)).toBeNull())
    expect(owner.registry.runtime.lifecycle.get().active).toBe(true)
    act(() => mounted.unmount())
    expect(getConversationNavigationProof(owner.client)).toBeNull()
    await waitFor(() => expect(owner.registry.runtime.lifecycle.get().active).toBe(false))
    expect(assign).not.toHaveBeenCalled()
  })
})
