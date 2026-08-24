import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import {
  startDmRouteVerification,
  useDmRouteVerification,
  verifyDmRoute,
  type DmRouteVerificationStatus,
} from "./use-dm-route-verification"

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function Capture({
  dmId,
  dms,
  onRender,
}: {
  dmId: string | undefined
  dms: readonly DM[]
  onRender: (status: DmRouteVerificationStatus) => void
}) {
  onRender(useDmRouteVerification(dmId, dms))
  return null
}

async function renderHook(
  queryClient: QueryClient,
  props: React.ComponentProps<typeof Capture>,
) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, props),
        ),
      ),
    )
  })
  return renderer
}

async function waitFor(predicate: () => boolean, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  expect(predicate()).toBe(true)
}

describe("DM route verification", () => {
  beforeEach(() => apiFetchMock.mockReset())
  afterEach(() => onlineManager.setOnline(true))

  it("bypasses a fresh cached miss, updates the canonical list, and dedupes callers", async () => {
    const queryClient = client()
    queryClient.setQueryData(communityKeys.dms(), { conversations: [] })
    const authoritative = {
      conversations: [{
        id: "dm-new",
        userId: "u-new",
        name: "New peer",
        discriminator: "2222",
        avatar: "N",
        status: "offline" as const,
        preview: "",
      }],
    }
    apiFetchMock.mockResolvedValue(authoritative)

    const [first, second] = await Promise.all([
      startDmRouteVerification(queryClient, "dm-new"),
      startDmRouteVerification(queryClient, "dm-new"),
    ])

    expect(first).toBe("present")
    expect(second).toBe("present")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/dms")
    expect(queryClient.getQueryData(communityKeys.dms())).toEqual(authoritative)
  })

  it("confirms a fresh missing target with one authority request", async () => {
    const queryClient = client()
    queryClient.setQueryData(communityKeys.dms(), { conversations: [] })
    apiFetchMock.mockResolvedValue({ conversations: [] })

    await expect(startDmRouteVerification(queryClient, "dm-missing")).resolves.toBe("missing")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404])("classifies explicit %s as denied", async (status) => {
    const queryClient = {
      fetchQuery: vi.fn().mockRejectedValue(Object.assign(new Error("unavailable"), { status })),
    } as unknown as QueryClient
    await expect(verifyDmRoute(queryClient, "dm-denied")).resolves.toBe("denied")
  })

  it("does not convert a transient failure into a missing result", async () => {
    const queryClient = {
      fetchQuery: vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { status: 0 })),
    } as unknown as QueryClient
    await expect(verifyDmRoute(queryClient, "dm-offline")).rejects.toMatchObject({ status: 0 })
  })

  it("fetches and settles a cold missing route under Strict Mode", async () => {
    const queryClient = client()
    const request = deferred<{ conversations: DM[] }>()
    apiFetchMock.mockReturnValue(request.promise)
    const statuses: DmRouteVerificationStatus[] = []
    const renderer = await renderHook(queryClient, {
      dmId: "dm-missing",
      dms: [],
      onRender: (status) => statuses.push(status),
    })

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(statuses).toContain("pending")
    await act(async () => request.resolve({ conversations: [] }))
    await waitFor(() => statuses.at(-1) === "missing")

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })

  it("shares a click-started request with the route observer", async () => {
    const queryClient = client()
    const request = deferred<{ conversations: DM[] }>()
    const provisional: DM = {
      id: "dm-new",
      userId: "u-new",
      name: "New peer",
      discriminator: "2222",
      avatar: "N",
      status: "offline",
      preview: "",
    }
    apiFetchMock.mockReturnValue(request.promise)
    const started = startDmRouteVerification(queryClient, provisional.id)
    const statuses: DmRouteVerificationStatus[] = []
    const renderer = await renderHook(queryClient, {
      dmId: provisional.id,
      dms: [provisional],
      onRender: (status) => statuses.push(status),
    })

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(statuses.at(-1)).toBe("present")
    await act(async () => request.resolve({ conversations: [provisional] }))
    await expect(started).resolves.toBe("present")
    await waitFor(() => statuses.at(-1) === "present")

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })

  it("keeps a transient route verification failure pending", async () => {
    const queryClient = client()
    const statuses: DmRouteVerificationStatus[] = []
    const queryKey = communityKeys.dmRouteVerification("dm-offline")
    await queryClient.fetchQuery({
      queryKey,
      queryFn: () => Promise.reject(Object.assign(new Error("offline"), { status: 0 })),
      retry: false,
    }).catch(() => undefined)
    onlineManager.setOnline(false)
    const renderer = await renderHook(queryClient, {
      dmId: "dm-offline",
      dms: [],
      onRender: (status) => statuses.push(status),
    })

    expect(statuses.at(-1)).toBe("pending")
    expect(statuses).not.toContain("missing")
    expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe("paused")
    expect(apiFetchMock).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("stays idle without a route and trusts an existing canonical row", async () => {
    const queryClient = client()
    const canonical: DM = {
      id: "dm-existing",
      userId: "u-existing",
      name: "Existing peer",
      discriminator: "1111",
      avatar: "E",
      status: "online",
      preview: "hello",
    }
    const statuses: DmRouteVerificationStatus[] = []
    const renderer = await renderHook(queryClient, {
      dmId: undefined,
      dms: [],
      onRender: (status) => statuses.push(status),
    })

    expect(statuses.at(-1)).toBe("idle")
    await act(async () => {
      renderer.update(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Capture, {
              dmId: canonical.id,
              dms: [canonical],
              onRender: (status) => statuses.push(status),
            }),
          ),
        ),
      )
    })

    expect(statuses.at(-1)).toBe("present")
    expect(apiFetchMock).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
