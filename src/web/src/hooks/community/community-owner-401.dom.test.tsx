import "fake-indexeddb/auto"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
import { useCreateBot } from "./use-bots"

const sdk = vi.hoisted(() => ({ id: "owner" }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
beforeEach(async () => { await clearAllPersistedCaches() })
afterEach(() => { vi.unstubAllGlobals() })

async function mountOwner(viewerId: string, children: React.ReactNode) {
  sdk.id = viewerId
  let client: QueryClient | undefined
  function Capture() { client = useQueryClient(); return <>{children}</> }
  const mounted = render(<QueryProvider userId={viewerId}><Capture /></QueryProvider>)
  await waitFor(() => expect(client).toBeDefined())
  const registry = getCommunityDbRegistry(client!)!
  await act(async () => { await registry.ready })
  return { registry, mounted }
}

function hold401() {
  let settle!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { settle = resolve }))
  vi.stubGlobal("fetch", fetch)
  const assign = vi.fn()
  const actualWindow = window
  vi.stubGlobal("window", new Proxy(actualWindow, {
    get(target, key) {
      if (key === "location") return { origin: "https://alook.test", assign }
      return Reflect.get(target, key, target)
    },
  }))
  return { fetch, assign, settle: () => settle(new Response("", { status: 401 })) }
}

describe("community request owner before the 401 global transition", () => {
  it.each([false, true])("bot mutation retired=%s", async (retired) => {
    let mutation: ReturnType<typeof useCreateBot> | null = null
    function Probe() { mutation = useCreateBot(); return null }
    const owner = await mountOwner("bot-viewer", <Probe />)
    const request = hold401()
    let result: Promise<unknown>
    await act(async () => {
      result = mutation!.mutateAsync({ name: "Held", machineId: "machine", runtime: "codex" }).catch((error: unknown) => error)
    })
    await waitFor(() => expect(request.fetch).toHaveBeenCalledOnce())
    if (retired) act(() => owner.mounted.unmount())
    let error: unknown
    await act(async () => { request.settle(); error = await result! })
    expect(error).toMatchObject({ name: "AbortError" })
    if (!retired) {
      expect(owner.registry.runtime.lifecycle.get().active).toBe(false)
      expect(owner.registry.queryClient.getQueryCache().getAll()).toHaveLength(0)
    }
    expect(request.assign).toHaveBeenCalledTimes(retired ? 0 : 1)
    if (!retired) expect(String(request.assign.mock.calls[0][0])).toBe("https://alook.test/sign-in")
  })

  it.each([false, true])("profile read retired=%s", async (retired) => {
    const owner = await mountOwner("profile-viewer", null)
    const request = hold401()
    const result = apiFetchProfiles<{ id: string }>("/api/community/users/me/profile", () => [], undefined, owner.registry).catch((error: unknown) => error)
    await waitFor(() => expect(request.fetch).toHaveBeenCalledOnce())
    if (retired) act(() => owner.mounted.unmount())
    let error: unknown
    await act(async () => { request.settle(); error = await result })
    expect(error).toMatchObject({ name: "AbortError" })
    if (!retired) {
      expect(owner.registry.runtime.lifecycle.get().active).toBe(false)
      expect(owner.registry.queryClient.getQueryCache().getAll()).toHaveLength(0)
    }
    expect(request.assign).toHaveBeenCalledTimes(retired ? 0 : 1)
  })
})
