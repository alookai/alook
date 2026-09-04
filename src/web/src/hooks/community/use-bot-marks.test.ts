import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import { useBotMarks } from "./use-bot-marks"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

type Result = ReturnType<typeof useBotMarks>
const renderers = new Set<TestRenderer.ReactTestRenderer>()

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderHook(botId: string | null, queryClient = createQueryClient()) {
  const result: { current: Result } = { current: null as never }
  function Probe() {
    result.current = useBotMarks(botId)
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe),
      ),
    )
  })
  renderers.add(renderer)
  return { queryClient, renderer, result }
}

async function waitFor(predicate: () => boolean, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  expect(predicate()).toBe(true)
}

describe("useBotMarks", () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  afterEach(() => {
    act(() => {
      for (const renderer of renderers) renderer.unmount()
    })
    renderers.clear()
  })

  it("fetches the owned bot's mark queue and stays disabled without a bot id", async () => {
    apiFetch.mockResolvedValueOnce({
      marked: [{ id: "mark_1", m: { id: "message_1", content: "Ship it" } }],
    })
    const { result } = renderHook("bot_1")
    await waitFor(() => result.current.marks.length === 1)

    expect(apiFetch).toHaveBeenCalledWith("/api/community/bots/bot_1/marks")
    renderHook(null)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("reports owner-gate 404s without retrying", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError("not found", 404))
    const { result } = renderHook("bot_1")
    await waitFor(() => result.current.isNotFound)

    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("refetches the authoritative queue whenever the profile remounts", async () => {
    apiFetch.mockResolvedValue({ marked: [] })
    const queryClient = createQueryClient()
    const first = renderHook("bot_1", queryClient)
    await waitFor(() => apiFetch.mock.calls.length === 1 && !first.result.current.isLoading)

    act(() => first.renderer.unmount())
    renderers.delete(first.renderer)
    renderHook("bot_1", queryClient)
    await waitFor(() => apiFetch.mock.calls.length === 2)

    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/community/bots/bot_1/marks")
  })
})
