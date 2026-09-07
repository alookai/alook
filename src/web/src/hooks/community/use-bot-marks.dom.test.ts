import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { ApiError } from "@/lib/errors"
import { useBotMarks } from "./use-bot-marks"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
}

function renderBotMarks(botId: string | null, queryClient = createQueryClient()) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  )
  return {
    ...renderHook(() => useBotMarks(botId), { wrapper }),
    queryClient,
  }
}

describe("useBotMarks", () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it("fetches the owned bot's mark queue and stays disabled without a bot id", async () => {
    apiFetch.mockResolvedValueOnce({
      marked: [{ id: "mark_1", m: { id: "message_1", content: "Ship it" } }],
    })
    const rendered = renderBotMarks("bot_1")
    await waitFor(() => expect(rendered.result.current.marks).toHaveLength(1))

    expect(apiFetch).toHaveBeenCalledWith("/api/community/bots/bot_1/marks")
    renderBotMarks(null)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("reports owner-gate 404s without retrying", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError("not found", 404))
    const rendered = renderBotMarks("bot_1")
    await waitFor(() => expect(rendered.result.current.isNotFound).toBe(true))

    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("refetches the authoritative queue whenever the profile remounts", async () => {
    apiFetch.mockResolvedValue({ marked: [] })
    const queryClient = createQueryClient()
    const first = renderBotMarks("bot_1", queryClient)
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledOnce()
      expect(first.result.current.isLoading).toBe(false)
    })

    first.unmount()
    renderBotMarks("bot_1", queryClient)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/community/bots/bot_1/marks")
  })
})
