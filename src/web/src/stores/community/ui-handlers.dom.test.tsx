import { describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { renderCommunityHook } from "@/test/community-owner-harness"
import { useCommunityRuntime } from "./runtime"
import { useUiHandlers } from "./index"

describe("community Back handler forwarding", () => {
  it("uses the current handler and preserves the explicit parent and default request", () => {
    const { result, rerender } = renderCommunityHook(() => ({ handlers: useUiHandlers(), ui: useCommunityRuntime().ui }))
    const handlers = result.current.handlers
    expect(() => handlers.goBackMobile("/c/me")).not.toThrow()
    const first = vi.fn(), replacement = vi.fn()
    act(() => result.current.ui.actions.registerUiHandlers({ goBackMobile: first }))
    handlers.goBackMobile("/c/channels/server/parent")
    expect(first).toHaveBeenCalledExactlyOnceWith("/c/channels/server/parent")
    act(() => result.current.ui.actions.registerUiHandlers({ goBackMobile: replacement }))
    rerender()
    expect(result.current.handlers).toBe(handlers)
    handlers.goBackMobile()
    expect(replacement).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
