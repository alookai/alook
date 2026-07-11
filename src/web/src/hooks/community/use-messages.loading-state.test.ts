import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useMessages } from "./use-messages"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

// Regression test for the "brand-new channel flashes a frame of fake-empty
// content instead of the skeleton" bug: while the anchor snapshot is still
// resolving, `useMessages` disables its underlying query — TanStack forces
// `isFetching` to `false` when `enabled: false`, so the native
// `isLoading = isPending && isFetching` computes to `false` even though
// nothing has loaded. Renders a tiny consumer via `react-test-renderer`
// (this repo's existing pattern — see message-list.mount-identity.test.ts)
// and captures the hook's return value.
function Capture({ onResult, channelId, lastReadMessageId }: {
  onResult: (r: { isLoading: boolean; messages: unknown[] }) => void
  channelId: string | null
  lastReadMessageId?: string | null
}) {
  const result = useMessages(channelId, { lastReadMessageId })
  onResult({ isLoading: result.isLoading, messages: result.messages })
  return null
}

function renderCapture(
  onResult: (r: { isLoading: boolean; messages: unknown[] }) => void,
  lastReadMessageId: string | null | undefined,
) {
  const queryClient = new QueryClient()
  act(() => {
    TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Capture, { onResult, channelId: "ch_new", lastReadMessageId }),
      ),
    )
  })
}

describe("useMessages — isLoading while the anchor snapshot is unresolved", () => {
  it("reports isLoading: true even though the underlying query is disabled (enabled: false forces isFetching: false)", () => {
    let latest: { isLoading: boolean; messages: unknown[] } | undefined
    // `lastReadMessageId: undefined` — the anchor snapshot resolving case
    // (see MessagesOpts' doc comment in use-messages.ts): `enabled` is false.
    renderCapture((r) => { latest = r }, undefined)

    expect(latest?.isLoading).toBe(true)
    expect(latest?.messages).toEqual([])
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("reports isLoading: true while the now-enabled query's first fetch is in flight", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})) // never resolves
    let latest: { isLoading: boolean; messages: unknown[] } | undefined
    // `lastReadMessageId: null` — anchor resolved (no anchor), query enabled
    // and genuinely fetching.
    renderCapture((r) => { latest = r }, null)

    expect(latest?.isLoading).toBe(true)
  })
})
