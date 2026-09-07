import { createElement, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderDirectory(
  client: ReturnType<typeof createQueryClient>,
  enabled: boolean,
) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client },
    children,
  )
  return renderHook(
    ({ active }: { active: boolean }) => useChannelRefDirectory(active),
    { initialProps: { active: enabled }, wrapper },
  )
}

describe("channelRefDirectoryQueryFn", () => {
  beforeEach(() => vi.clearAllMocks())

  it("loads the complete directory through one lightweight request", async () => {
    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    apiFetch.mockResolvedValue({ directory })

    await expect(channelRefDirectoryQueryFn()).resolves.toEqual(directory)
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/channel-directory")
    expect(apiFetch).toHaveBeenCalledOnce()
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
    const rendered = renderDirectory(client, false)
    expect(apiFetch).not.toHaveBeenCalled()
    expect(rendered.result.current).toMatchObject({
      directory: [],
      isResolved: false,
      isLoading: false,
      isError: false,
    })

    rendered.rerender({ active: true })
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(rendered.result.current).toMatchObject({
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
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true))
    expect(rendered.result.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })

  it("treats a 200 empty directory as resolved", async () => {
    apiFetch.mockResolvedValue({ directory: [] })
    const client = createQueryClient()
    const rendered = renderDirectory(client, true)

    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true))
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(rendered.result.current).toMatchObject({
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
    const rendered = renderDirectory(createQueryClient(), true)

    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(rendered.result.current).toMatchObject({
      directory: [],
      isResolved: false,
      isLoading: false,
      isError: true,
    })

    await act(async () => {
      await rendered.result.current.refetch()
    })
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true))
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(rendered.result.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })

  it("uses warm cached data without fetching when enabled", () => {
    const directory = [{
      id: "server_1",
      name: "Studio",
      discriminator: "0042",
      channels: [{ id: "channel_1", name: "general" }],
    }]
    const client = createQueryClient()
    client.setQueryData(communityKeys.channelRefDirectory(), directory)
    const rendered = renderDirectory(client, false)
    expect(rendered.result.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })

    rendered.rerender({ active: true })
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
    const rendered = renderDirectory(client, true)

    await act(async () => {
      await rendered.result.current.refetch()
    })
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(rendered.result.current).toMatchObject({
      directory,
      isResolved: true,
      isLoading: false,
      isError: false,
    })
  })
})
