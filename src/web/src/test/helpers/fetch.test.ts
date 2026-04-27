import { describe, it, expect, vi } from "vitest"
import { isRetryableError, fetchWithRetry } from "./fetch"

describe("isRetryableError", () => {
  it("detects ECONNRESET on err.cause (Node.js fetch wrapper)", () => {
    const inner = new Error("read ECONNRESET") as NodeJS.ErrnoException
    inner.code = "ECONNRESET"
    inner.errno = -54
    inner.syscall = "read"
    const outer = new TypeError("fetch failed", { cause: inner })
    expect(isRetryableError(outer)).toBe(true)
  })

  it("detects ECONNRESET directly on err.code", () => {
    const err = new Error("read ECONNRESET") as NodeJS.ErrnoException
    err.code = "ECONNRESET"
    expect(isRetryableError(err)).toBe(true)
  })

  it("detects TypeError with 'fetch failed' message", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true)
  })

  it("rejects plain Error without retryable indicators", () => {
    expect(isRetryableError(new Error("something else"))).toBe(false)
  })

  it("rejects non-Error values", () => {
    expect(isRetryableError("string error")).toBe(false)
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(42)).toBe(false)
  })

  it("rejects TypeError with non-fetch message", () => {
    expect(isRetryableError(new TypeError("Cannot read property"))).toBe(false)
  })
})

describe("fetchWithRetry", () => {
  it("returns response on first success", async () => {
    const mockResponse = new Response("ok", { status: 200 })
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse)

    const res = await fetchWithRetry("http://test", { method: "GET" })
    expect(res).toBe(mockResponse)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockRestore()
  })

  it("retries on ECONNRESET then succeeds", async () => {
    const inner = new Error("read ECONNRESET") as NodeJS.ErrnoException
    inner.code = "ECONNRESET"
    const econnErr = new TypeError("fetch failed", { cause: inner })
    const mockResponse = new Response("ok", { status: 200 })

    const mockFetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(econnErr)
      .mockResolvedValueOnce(mockResponse)

    const res = await fetchWithRetry("http://test", { method: "GET" })
    expect(res).toBe(mockResponse)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    mockFetch.mockRestore()
  })

  it("throws after max retries exhausted", async () => {
    const makeErr = () => {
      const inner = new Error("read ECONNRESET") as NodeJS.ErrnoException
      inner.code = "ECONNRESET"
      return new TypeError("fetch failed", { cause: inner })
    }

    const mockFetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(makeErr())
      .mockRejectedValueOnce(makeErr())
      .mockRejectedValueOnce(makeErr())

    await expect(fetchWithRetry("http://test", { method: "GET" })).rejects.toThrow("fetch failed")
    expect(mockFetch).toHaveBeenCalledTimes(3)

    mockFetch.mockRestore()
  })

  it("throws immediately on non-retryable error", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("DNS resolution failed"))

    await expect(fetchWithRetry("http://test", { method: "GET" })).rejects.toThrow("DNS resolution failed")
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockFetch.mockRestore()
  })
})
