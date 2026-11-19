import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { messageRendererStorageKey, selectMessageRenderer, useMessageRendererSettings } from "./message-renderer-settings"

const adapter = vi.hoisted(() => ({ resolve: null as (() => void) | null }))
vi.mock("./chatscope-message-cell", async () => {
  await new Promise<void>(resolve => { adapter.resolve = resolve })
  return { ChatscopeMessageCell: () => null }
})
afterEach(() => vi.restoreAllMocks())

describe("local message renderer preference", () => {
  it("waits for a stored candidate and retires that load when Current is requested", async () => {
    localStorage.setItem(messageRendererStorageKey("pending-account"), "chatscope")
    const hook = renderHook(() => useMessageRendererSettings("pending-account"))
    expect(hook.result.current.ready).toBe(false)
    await waitFor(() => expect(adapter.resolve).not.toBeNull())
    await act(() => selectMessageRenderer("pending-account", "current"))
    expect(hook.result.current.ready).toBe(true)
    expect(hook.result.current.id).toBe("current")
    await act(async () => { adapter.resolve!(); await Promise.resolve() })
    expect(hook.result.current.id).toBe("current")
    expect(localStorage.getItem(messageRendererStorageKey("pending-account"))).toBe("current")
  })

  it("isolates account choices and restores a stored choice on a new account mount", async () => {
    const hook = renderHook(({ id }) => useMessageRendererSettings(id), { initialProps: { id: "account-a" } })
    expect(hook.result.current.id).toBe("current")
    await act(() => selectMessageRenderer("account-a", "chatscope"))
    expect(hook.result.current.id).toBe("chatscope")
    expect(localStorage.getItem(messageRendererStorageKey("account-a"))).toBe("chatscope")
    hook.rerender({ id: "account-b" })
    expect(hook.result.current.id).toBe("current")
    localStorage.setItem(messageRendererStorageKey("stored-account"), "chatscope")
    hook.rerender({ id: "stored-account" })
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    expect(hook.result.current.id).toBe("chatscope")
    expect(localStorage.getItem(messageRendererStorageKey("account-b"))).toBeNull()
  })

  it("uses Current for missing, corrupt and unavailable storage without a server call", async () => {
    const fetch = vi.spyOn(window, "fetch")
    localStorage.setItem(messageRendererStorageKey("corrupt-account"), '{"renderer":"chatscope"}')
    const hook = renderHook(({ id }) => useMessageRendererSettings(id), { initialProps: { id: "corrupt-account" } })
    expect(hook.result.current.ready).toBe(true)
    expect(hook.result.current.id).toBe("current")
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError") })
    hook.rerender({ id: "denied-account" })
    expect(hook.result.current.ready).toBe(true)
    expect(hook.result.current.id).toBe("current")
    expect(hook.result.current.storageAvailable).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns to Current when a candidate choice cannot be saved", async () => {
    const hook = renderHook(() => useMessageRendererSettings("write-denied"))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError") })
    await act(() => selectMessageRenderer("write-denied", "chatscope"))
    expect(hook.result.current.id).toBe("current")
    expect(hook.result.current.error).toContain("could not save")
    expect(hook.result.current.component).not.toBeNull()
  })

  it("shares one storage listener per account and releases it with the last consumer", () => {
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")
    const one = renderHook(() => useMessageRendererSettings("shared-listener"))
    const two = renderHook(() => useMessageRendererSettings("shared-listener"))
    const listeners = add.mock.calls.filter(call => String(call[0]) === "storage")
    expect(listeners).toHaveLength(1)
    one.unmount()
    expect(remove.mock.calls.filter(call => String(call[0]) === "storage")).toHaveLength(0)
    two.unmount()
    expect(remove).toHaveBeenCalledWith("storage", listeners[0][1])
  })
})
