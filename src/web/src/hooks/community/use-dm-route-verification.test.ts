import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import {
  classifyDmRouteAuthorityError,
  startDmRouteVerification,
  DM_ROUTE_AUTHORITY_HEADER,
  useDmRouteVerification,
  type DmRouteVerificationResult,
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
  canonicalUnsettled = false,
  onRender,
  onResult,
}: {
  dmId: string | undefined
  dms: readonly DM[]
  canonicalUnsettled?: boolean
  onRender: (status: DmRouteVerificationStatus) => void
  onResult?: (result: DmRouteVerificationResult) => void
}) {
  const result = useDmRouteVerification(dmId, dms, canonicalUnsettled)
  onRender(result.status)
  onResult?.(result)
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
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/dms",
      { headers: { [DM_ROUTE_AUTHORITY_HEADER]: "1" } },
    )
    expect(queryClient.getQueryData(communityKeys.dms())).toEqual(authoritative)
  })

  it("confirms a fresh missing target with one authority request", async () => {
    const queryClient = client()
    queryClient.setQueryData(communityKeys.dms(), { conversations: [] })
    apiFetchMock.mockResolvedValue({ conversations: [] })

    await expect(startDmRouteVerification(queryClient, "dm-missing")).resolves.toBe("missing")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("trusts a provisional canonical cache row without starting authority", async () => {
    const queryClient = client()
    const provisional: DM = {
      id: "dm-provisional",
      userId: "u-provisional",
      name: "Provisional peer",
      discriminator: "4444",
      avatar: "P",
      status: "offline",
      preview: "",
    }
    queryClient.setQueryData(communityKeys.dms(), { conversations: [provisional] })

    await expect(startDmRouteVerification(queryClient, provisional.id)).resolves.toBe("present")
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it.each([403, 404])("classifies explicit %s as denied", async (status) => {
    expect(classifyDmRouteAuthorityError({ status })).toBe("denied")
  })

  it("does not classify a transient failure as denied", () => {
    expect(classifyDmRouteAuthorityError({ status: 0 })).toBe("error")
    expect(classifyDmRouteAuthorityError(new Error("offline"))).toBe("error")
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

  it("waits for the canonical DMs query before verifying an absent route", async () => {
    const queryClient = client()
    apiFetchMock.mockResolvedValue({ conversations: [] })
    const statuses: DmRouteVerificationStatus[] = []
    const props = {
      dmId: "dm-missing",
      dms: [],
      canonicalUnsettled: true,
      onRender: (status: DmRouteVerificationStatus) => statuses.push(status),
    }
    const renderer = await renderHook(queryClient, props)

    expect(statuses.at(-1)).toBe("pending")
    expect(apiFetchMock).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Capture, { ...props, canonicalUnsettled: false }),
          ),
        ),
      )
    })
    await waitFor(() => statuses.at(-1) === "missing")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })

  it("waits for a stale canonical refetch that eventually contains the route", async () => {
    const queryClient = client()
    const canonical: DM = {
      id: "dm-refetched",
      userId: "u-refetched",
      name: "Refetched peer",
      discriminator: "3333",
      avatar: "R",
      status: "offline",
      preview: "",
    }
    const statuses: DmRouteVerificationStatus[] = []
    const props = {
      dmId: canonical.id,
      dms: [],
      canonicalUnsettled: true,
      onRender: (status: DmRouteVerificationStatus) => statuses.push(status),
    }
    const renderer = await renderHook(queryClient, props)

    expect(statuses.at(-1)).toBe("pending")
    expect(apiFetchMock).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Capture, {
              ...props,
              dms: [canonical],
              canonicalUnsettled: false,
            }),
          ),
        ),
      )
    })

    expect(statuses.at(-1)).toBe("present")
    expect(apiFetchMock).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("starts one authority request after a stale canonical refetch remains absent", async () => {
    const queryClient = client()
    apiFetchMock.mockResolvedValue({ conversations: [] })
    const statuses: DmRouteVerificationStatus[] = []
    const props = {
      dmId: "dm-still-missing",
      dms: [],
      canonicalUnsettled: true,
      onRender: (status: DmRouteVerificationStatus) => statuses.push(status),
    }
    const renderer = await renderHook(queryClient, props)

    expect(statuses.at(-1)).toBe("pending")
    expect(apiFetchMock).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Capture, { ...props, canonicalUnsettled: false }),
          ),
        ),
      )
    })
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

  it("surfaces a transient failure and retries only the current verification", async () => {
    const queryClient = client()
    const statuses: DmRouteVerificationStatus[] = []
    let latest!: DmRouteVerificationResult
    apiFetchMock.mockRejectedValueOnce(Object.assign(new Error("offline"), { status: 0 }))
    const renderer = await renderHook(queryClient, {
      dmId: "dm-offline",
      dms: [],
      onRender: (status) => statuses.push(status),
      onResult: (result) => { latest = result },
    })

    await waitFor(() => statuses.at(-1) === "error")
    expect(statuses).not.toContain("missing")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    apiFetchMock.mockResolvedValueOnce({ conversations: [] })
    await act(async () => latest.retry())
    await waitFor(() => statuses.at(-1) === "missing")
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
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
