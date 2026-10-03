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
  beforeEach(() => { toastErrorMock.mockReset() })

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

describe("toast eligibility at publication", () => {
  beforeEach(() => { toastErrorMock.mockReset() })
  it("drops an ordinary failure retired during sonner import", async () => {
    let active = true
    const assertActive = vi.fn(() => { if (!active) throw new DOMException("retired", "AbortError") })
    toastApiError(new Error("old failure"), "Failed", assertActive)
    active = false
    await new Promise((done) => setTimeout(done, 0))
    expect(assertActive).toHaveBeenCalledOnce()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })
  it("publishes a current failure after checking the original intent", async () => {
    const assertActive = vi.fn()
    toastApiError(new Error("current failure"), "Failed", assertActive)
    await new Promise((done) => setTimeout(done, 0))
    expect(assertActive).toHaveBeenCalledOnce()
    expect(toastErrorMock).toHaveBeenCalledWith("current failure")
  })
  it("keeps normal owner retirement silent", async () => {
    toastApiError(new DOMException("retired", "AbortError"), "Failed")
    await new Promise((done) => setTimeout(done, 0))
    expect(toastErrorMock).not.toHaveBeenCalled()
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

vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: vi.fn() }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }))

describe("apiFetch account-qualified authentication effects", () => {
  it.each(["account", "workspace"] as const)("late 401 after %s retirement cannot redirect the next account", async (retirement) => {
    const { createApplicationOwner, retireApplicationOwner } = await import("@/lib/application-owner")
    const { createWorkspaceOwner, runWorkspaceRequest } = await import("@/contexts/workspace-context")
    const { apiFetch } = await import("./client")
    let release!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    const assign = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("window", { location: { origin: "https://alook.test", assign } })
    const application = createApplicationOwner("viewer-a")
    const workspace = createWorkspaceOwner(application, "workspace-a", "a")
    try {
      const request = runWorkspaceRequest(workspace, (options) => apiFetch("/api/test", options))
      const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" })
      if (retirement === "account") retireApplicationOwner(application)
      else workspace.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
      release(new Response(null, { status: 401 }))
      await rejected
      expect(assign).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("assertActive")
    } finally {
      application.queryClient.clear()
      vi.unstubAllGlobals()
    }
  })

  it("current owner 401 keeps the full-document sign-in navigation", async () => {
    const { createApplicationOwner } = await import("@/lib/application-owner")
    const { createWorkspaceOwner, runWorkspaceRequest } = await import("@/contexts/workspace-context")
    const { apiFetch } = await import("./client")
    const assign = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    vi.stubGlobal("window", { location: { origin: "https://alook.test", assign } })
    const application = createApplicationOwner("viewer-a")
    try {
      await expect(runWorkspaceRequest(createWorkspaceOwner(application, "workspace-a", "a"), (options) => apiFetch("/api/test", options)))
        .rejects.toMatchObject({ status: 401 })
      expect(assign).toHaveBeenCalledOnce()
      expect(String(assign.mock.calls[0][0])).toBe("https://alook.test/sign-in")
    } finally {
      application.queryClient.clear()
      vi.unstubAllGlobals()
    }
  })
})

describe("account-qualified deletion auth transition", () => {
  it("A transition does not suppress B authentication exit", async () => {
    const { apiFetch, beginAccountDeletionAuthTransition, cancelAccountDeletionAuthTransition } = await import("./client")
    const lease = beginAccountDeletionAuthTransition("A"), exit = vi.fn().mockResolvedValue(true), assign = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 }))); vi.stubGlobal("window", { location: { origin: "https://alook.test", assign } })
    try { await expect(apiFetch("/private", { authenticationAccount: "B", onUnauthorized: exit })).rejects.toMatchObject({ status: 401 }); expect(exit).toHaveBeenCalledOnce(); expect(assign).toHaveBeenCalledOnce() }
    finally { cancelAccountDeletionAuthTransition(lease); vi.unstubAllGlobals() }
  })
  it("A in-progress delete keeps its own owner until completion and an old lease cannot clear a newer one", async () => {
    const { apiFetch, beginAccountDeletionAuthTransition, cancelAccountDeletionAuthTransition, hasAccountDeletionAuthTransition } = await import("./client")
    const old = beginAccountDeletionAuthTransition("A"), current = beginAccountDeletionAuthTransition("A"), exit = vi.fn(), assign = vi.fn()
    cancelAccountDeletionAuthTransition(old); expect(hasAccountDeletionAuthTransition("A")).toBe(true)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 }))); vi.stubGlobal("window", { location: { origin: "https://alook.test", assign } })
    try { await expect(apiFetch("/private", { authenticationAccount: "A", onUnauthorized: exit })).rejects.toMatchObject({ status: 401 }); expect(exit).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled() }
    finally { cancelAccountDeletionAuthTransition(current); vi.unstubAllGlobals() }
  })
})
