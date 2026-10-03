import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONVERSATION_READ_TIMEOUT_MS, ConversationReadTimeoutError, retryConversationRead, withConversationReadDeadline } from "./conversation-read"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("conversation read deadline", () => {
  it("rejects a transport that ignores cancellation and aborts its original publication signal", async () => {
    let resolve!: (value: string) => void
    let signal!: AbortSignal
    const read = withConversationReadDeadline(undefined, (current) => {
      signal = current
      return new Promise<string>((done) => { resolve = done })
    })
    const result = expect(read).rejects.toBeInstanceOf(ConversationReadTimeoutError)
    await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
    await result
    expect(signal.aborted).toBe(true)
    expect(retryConversationRead(0, signal.reason)).toBe(false)
    resolve("late")
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps a successful empty result distinct from a timeout and disposes the timer", async () => {
    await expect(withConversationReadDeadline(undefined, async () => [])).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("follows the original Query cancellation without starting a replacement read", async () => {
    const controller = new AbortController()
    const transport = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}))
    const read = withConversationReadDeadline(controller.signal, transport)
    const result = expect(read).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    controller.abort(new DOMException("Account retired", "AbortError"))
    await result
    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0][0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not start a read whose original owner is already retired", async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = vi.fn(async () => "unexpected")
    await expect(withConversationReadDeadline(controller.signal, transport)).rejects.toMatchObject({ name: "AbortError" })
    expect(transport).not.toHaveBeenCalled()
  })

  it("retains one ordinary transient retry and refuses auth, access and timeout retries", () => {
    expect(retryConversationRead(0, new Error("transient"))).toBe(true)
    expect(retryConversationRead(1, new Error("transient"))).toBe(false)
    for (const status of [401, 403, 404]) expect(retryConversationRead(0, Object.assign(new Error("denied"), { status }))).toBe(false)
    expect(retryConversationRead(0, new ConversationReadTimeoutError())).toBe(false)
  })
  it("keeps cancellation and deadline behavior when AbortSignal.any is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
    try {
      const controller = new AbortController()
      let child!: AbortSignal
      const read = withConversationReadDeadline(controller.signal, (signal) => { child = signal; return new Promise<never>(() => {}) })
      const result = expect(read).rejects.toMatchObject({ name: "AbortError" })
      controller.abort()
      await result
      expect(child.aborted).toBe(true)
      const timed = withConversationReadDeadline(undefined, () => new Promise<never>(() => {}))
      const timeout = expect(timed).rejects.toBeInstanceOf(ConversationReadTimeoutError)
      await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
      await timeout
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor)
      else Reflect.deleteProperty(AbortSignal, "any")
    }
  })

})
