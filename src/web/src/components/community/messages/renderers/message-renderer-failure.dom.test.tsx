import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { messageRendererStorageKey, selectMessageRenderer, useMessageRendererSettings } from "./message-renderer-settings"

vi.mock("./chatscope-message-cell", () => { throw new Error("Candidate chunk failed") })

describe("message renderer load failure", () => {
  it("keeps the failed identity explicit and permits a return to Current", async () => {
    localStorage.setItem(messageRendererStorageKey("failed-load"), "chatscope")
    const hook = renderHook(() => useMessageRendererSettings("failed-load"))
    expect(hook.result.current.ready).toBe(false)
    await waitFor(() => expect(hook.result.current.error).toContain("could not load"))
    expect(hook.result.current.id).toBe("chatscope")
    expect(hook.result.current.component).toBeNull()
    await act(() => selectMessageRenderer("failed-load", "current"))
    expect(hook.result.current.id).toBe("current")
    expect(hook.result.current.component).not.toBeNull()
    expect(hook.result.current.error).toBeNull()
    expect(localStorage.getItem(messageRendererStorageKey("failed-load"))).toBe("current")
  })
})
