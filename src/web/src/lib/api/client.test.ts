import { describe, it, expect, vi, beforeEach } from "vitest"
import { ApiError } from "@/lib/errors"

const toastErrorMock = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}))

import { getErrorMessage, toastApiError, readUploadError } from "./client"

describe("getErrorMessage", () => {
  it("returns the ApiError's message when non-empty", () => {
    const err = new ApiError("File too large", 413)
    expect(getErrorMessage(err, "Upload failed")).toBe("File too large")
  })

  it("returns the fallback when the ApiError's message is empty", () => {
    const err = new ApiError("", 500)
    expect(getErrorMessage(err, "Something went wrong")).toBe("Something went wrong")
  })

  it("returns a plain Error's message when non-empty", () => {
    const err = new Error("network hiccup")
    expect(getErrorMessage(err, "Failed to save")).toBe("network hiccup")
  })

  it("returns the fallback when the plain Error's message is empty", () => {
    const err = new Error("")
    expect(getErrorMessage(err, "Failed to save")).toBe("Failed to save")
  })

  it("returns the fallback for non-Error values", () => {
    expect(getErrorMessage(undefined, "fallback")).toBe("fallback")
    expect(getErrorMessage(null, "fallback")).toBe("fallback")
    expect(getErrorMessage("just a string", "fallback")).toBe("fallback")
    expect(getErrorMessage({ message: "not an Error instance" }, "fallback")).toBe("fallback")
  })
})

describe("toastApiError", () => {
  beforeEach(() => toastErrorMock.mockReset())

  // `toastApiError` lazily `import("sonner")`s (see client.ts's doc comment
  // on why) — flush the microtask queue before asserting.
  it("calls toast.error with the resolved message from an ApiError", async () => {
    toastApiError(new ApiError("Name already taken", 409), "Failed to create server")
    await new Promise((r) => setTimeout(r, 0))
    expect(toastErrorMock).toHaveBeenCalledWith("Name already taken")
  })

  it("calls toast.error with the fallback when the error carries no message", async () => {
    toastApiError(new ApiError("", 500), "Failed to create server")
    await new Promise((r) => setTimeout(r, 0))
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to create server")
  })

  it("calls toast.error with the fallback for a non-Error value", async () => {
    toastApiError(undefined, "Failed to create server")
    await new Promise((r) => setTimeout(r, 0))
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to create server")
  })
})

describe("readUploadError", () => {
  it("parses a JSON { error } body and returns an ApiError with that message and status", async () => {
    const res = new Response(JSON.stringify({ error: "File exceeds 8MB limit" }), { status: 413 })
    const err = await readUploadError(res, "Upload failed")
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe("File exceeds 8MB limit")
    expect(err.status).toBe(413)
  })

  it("falls back to the provided message when the body is not valid JSON", async () => {
    const res = new Response("<html>not json</html>", { status: 500 })
    const err = await readUploadError(res, "Upload failed")
    expect(err.message).toBe("Upload failed")
    expect(err.status).toBe(500)
  })

  it("falls back to the provided message when the body has no error field", async () => {
    const res = new Response(JSON.stringify({ ok: false }), { status: 400 })
    const err = await readUploadError(res, "Upload failed")
    expect(err.message).toBe("Upload failed")
    expect(err.status).toBe(400)
  })
})
