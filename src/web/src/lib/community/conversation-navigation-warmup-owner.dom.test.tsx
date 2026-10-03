import React, { StrictMode, useLayoutEffect } from "react"
import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry, registerCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { createQueryClient } from "@/lib/query-client"
import { communityKeys } from "@/lib/query-keys"
import { apiFetch } from "@/lib/api/client"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"
import { getConversationNavigationProof, useConversationNavigationGate } from "./conversation-navigation-proof"

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
