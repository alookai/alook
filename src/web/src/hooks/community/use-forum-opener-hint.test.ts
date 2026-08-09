import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { useForumOpenerHint } from "./use-forum-opener-hint"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function Capture({ enabled }: { enabled: boolean }) {
  useForumOpenerHint("server-1", "opener-1", enabled)
  return null
}

beforeEach(() => apiFetchMock.mockReset())

describe("useForumOpenerHint", () => {
  it("does not fetch or authorize content before the route metadata is verified", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { enabled: false }),
        ),
      )
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("reuses a seeded lightweight hint without a full opener request", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-1"),
      { id: "opener-1", content: "Seeded" },
    )
    await act(async () => {
      TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, { enabled: true }),
        ),
      )
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
