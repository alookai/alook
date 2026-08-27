import { createElement, useEffect } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import { createQueryClient } from "@/lib/query-client"
import { communityKeys } from "@/lib/query-keys"
import {
  channelRefDirectoryQueryFn,
  useChannelRefDirectory,
} from "./use-channel-ref-directory"

type HookResult = ReturnType<typeof useChannelRefDirectory>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function Probe({
  enabled,
  resultRef,
}: {
  enabled: boolean
  resultRef: { current: HookResult | null }
}) {
  const result = useChannelRefDirectory(enabled)
  useEffect(() => {
    resultRef.current = result
  }, [result, resultRef])
  return createElement("channel-ref-directory-probe")
}

function renderHook(
  client: ReturnType<typeof createQueryClient>,
  enabled: boolean,
  resultRef: { current: HookResult | null },
) {
  return TestRenderer.create(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Probe, { enabled, resultRef }),
    ),
  )
}

async function waitForResult(predicate: () => boolean, tries = 80) {
  for (let index = 0; index < tries; index++) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error("timed out waiting for hook result")
}

describe("channelRefDirectoryQueryFn", () => {
  beforeEach(() => vi.clearAllMocks())

  it("loads the complete directory through one lightweight request", async () => {
    const directory = [
      {
        id: "server_1",
        name: "Studio",
        discriminator: "0042",
        channels: [{ id: "channel_1", name: "general" }],
      },
    ]
    apiFetch.mockResolvedValue({ directory })

    await expect(channelRefDirectoryQueryFn()).resolves.toEqual(directory)
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/channel-directory")
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})

describe("useChannelRefDirectory", () => {
  beforeEach(() => vi.clearAllMocks())

  it("stays dormant until enabled, then owns pending and resolved items", async () => {
    const request = deferred<{ directory: Array<{
      id: string
      name: string
      discriminator: string
      channels: Array<{ id: string; name: string }>
    }> }>()
    apiFetch.mockReturnValue(request.promise)
    const client = createQueryClient()
    const resultRef: { current: HookResult | null } = { current: null }
    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = renderHook(client, false, resultRef)
    })
    expect(apiFetch).not.toHaveBeenCalled()
    expect(resultRef.current).toMatchObject({
      directory: [],
      isResolved: false,
      isLoading: false,
      isError: false,
    })

    await act(async () => {
      renderer.update(createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, { enabled: true, resultRef }),
      ))
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(resultRef.current).toMatchObject({
      isResolved: false,
      isLoading: true,
      isError: false,
    })

    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    await act(async () => request.resolve({ directory }))
    await waitForResult(() => resultRef.current?.isResolved === true)
    expect(resultRef.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })

  it("treats a 200 empty directory as resolved", async () => {
    apiFetch.mockResolvedValue({ directory: [] })
    const client = createQueryClient()
    const resultRef: { current: HookResult | null } = { current: null }

    await act(async () => {
      renderHook(client, true, resultRef)
    })
    await waitForResult(() => resultRef.current?.isResolved === true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(resultRef.current).toMatchObject({
      directory: [],
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })

  it("overrides the app retry default and refetches once only on demand", async () => {
    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    apiFetch
      .mockRejectedValueOnce(new Error("directory unavailable"))
      .mockResolvedValueOnce({ directory })
    const client = createQueryClient()
    const resultRef: { current: HookResult | null } = { current: null }

    await act(async () => {
      renderHook(client, true, resultRef)
    })
    await waitForResult(() => resultRef.current?.isError === true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(resultRef.current).toMatchObject({
      directory: [],
      isResolved: false,
      isLoading: false,
      isError: true,
    })

    await act(async () => {
      await resultRef.current!.refetch()
    })
    await waitForResult(() => resultRef.current?.isResolved === true)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(resultRef.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })

  it("uses warm cached data without fetching when enabled", async () => {
    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    const client = createQueryClient()
    client.setQueryData(communityKeys.channelRefDirectory(), directory)
    const resultRef: { current: HookResult | null } = { current: null }
    let renderer!: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = renderHook(client, false, resultRef)
    })
    expect(resultRef.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })

    await act(async () => {
      renderer.update(createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, { enabled: true, resultRef }),
      ))
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("keeps cached rows resolved through a failed background refetch", async () => {
    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    const client = createQueryClient()
    client.setQueryData(communityKeys.channelRefDirectory(), directory)
    apiFetch.mockRejectedValue(new Error("background failure"))
    const resultRef: { current: HookResult | null } = { current: null }

    await act(async () => {
      renderHook(client, true, resultRef)
    })
    await act(async () => {
      await resultRef.current!.refetch()
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(resultRef.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })
})
