import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityRuntimeProvider } from "@/stores/community/runtime"
let registry: CommunityDbRegistry
import { CommunityWsReconnectBoundary } from "./community-ws-reconnect-overlay"
import { communityKeys } from "@/lib/query-keys"
import { messageReconcileOptions } from "@/hooks/community/community-ws/reconnect-messages"
import { ApiError } from "@/lib/errors"
const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

describe("CommunityWsReconnectBoundary", () => {
  beforeEach(() => {
    registry = createCommunityDbRegistry(new QueryClient(), "viewer")
    apiFetchMock.mockReset()

    vi.stubGlobal("matchMedia", vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})))
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(async () => {
    await act(async () => {
      await registry.cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })
  })

  function render() {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const renderer = renderDom(React.createElement(QueryClientProvider, { client: registry.queryClient }, React.createElement(CommunityRuntimeProvider, { value: { runtime: registry.runtime } }, React.createElement(
      CommunityWsReconnectBoundary,
      null,
      React.createElement("button", { type: "button" }, "Underlying action"),
    ))))
    return { renderer, focus }
  }

  it("leaves connected content interactive without rendering an overlay", () => {
    const { renderer } = render()
    const content = renderer.container.querySelector(".contents")!
    expect(content).not.toHaveAttribute("inert")
    expect(content).not.toHaveAttribute("aria-hidden")
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
  })

  it("keeps cached content interactive while connecting or reconnecting", () => {
    const { renderer, focus } = render()
    act(() => registry.runtime.ws.actions.setConnectionStatus("reconnecting"))

    const content = renderer.container.querySelector(".contents")!
    expect(content).not.toHaveAttribute("inert")
    expect(content).not.toHaveAttribute("aria-hidden")
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(focus).not.toHaveBeenCalled()
  })

  it("shows a non-modal Retry status without disabling cached content", () => {
    const reconnectNow = vi.fn()
    registry.runtime.ws.actions.bindReconnectNow(reconnectNow)
    const { renderer } = render()
    act(() => registry.runtime.ws.actions.setConnectionStatus("failed"))

    const status = screen.getByRole("status")
    expect(status).toHaveAttribute("aria-atomic", "true")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).not.toHaveAttribute("aria-modal")
    expect(status).toHaveTextContent("Connection lost")
    expect(status).toHaveTextContent("Cached content is still available.")
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
    const retry = screen.getByTestId(tid.wsRetry)
    expect(retry).toHaveClass("h-11", "sm:h-9")
    fireEvent.click(retry)
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => registry.runtime.ws.actions.setConnectionStatus("connected"))
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
  })

  it("keeps healthy transport independent and retries the failed active message window by keyboard", async () => {
    await registry.preload()
    const key = communityKeys.channelMessages("repair-status")
    registry.queryClient.setQueryData(key, {
      pages: [{ messages: [{ id: "m_1", seq: 1 }], latestSeq: 1 }], pageParams: [{ mode: "newest" }],
    })
    const observer = new QueryObserver(registry.queryClient, { queryKey: key, queryFn: async () => undefined, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => undefined)
    const reconnect = vi.fn()
    registry.runtime.ws.actions.bindReconnectNow(reconnect)
    apiFetchMock.mockRejectedValue(new ApiError("unavailable", 503))
    const { renderer } = render()
    await act(async () => {
      await registry.queryClient.query({ ...messageReconcileOptions(registry.queryClient, { kind: "channel", scopeId: "repair-status" }, key), retryDelay: 0 }).catch(() => undefined)
    })
    expect(screen.getByTestId(tid.messageRepairStatus)).toHaveTextContent("Messages could not refresh")
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    apiFetchMock.mockResolvedValue({ messages: [{ id: "m_1", seq: 1, content: "recovered" }], latestSeq: 1 })
    const retry = screen.getByTestId(tid.messageRepairRetry)
    retry.focus()
    await setupUser().keyboard("{Enter}")
    await waitFor(() => expect(screen.queryByTestId(tid.messageRepairStatus)).not.toBeInTheDocument())
    await waitFor(() => expect(registry.collections.messages.get("m_1")?.content).toBe("recovered"))
    expect(reconnect).not.toHaveBeenCalled()
    expect(apiFetchMock).toHaveBeenCalledTimes(4)
    unsubscribe()
  })
})
