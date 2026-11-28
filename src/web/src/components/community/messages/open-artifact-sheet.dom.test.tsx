import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { focusManager, onlineManager } from "@tanstack/react-query"
import { act, fireEvent, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { ApiError } from "@/lib/errors"
import * as apiClient from "@/lib/api/client"
import { HTML_PREVIEW_SANDBOX } from "@/lib/community/html-preview-policy"
import { OPEN_ARTIFACT_HOST_PROTOCOL, OPEN_ARTIFACT_SANDBOX } from "@/lib/community/open-artifact-policy"
import { tid } from "@/lib/community/testids"
import { OpenArtifactSheet } from "./open-artifact-sheet"

const themeState = vi.hoisted(() => ({ resolvedTheme: "light" as "light" | "dark" }))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: themeState.resolvedTheme }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}))

const samplePage = {
  kind: "alook_page" as const,
  id: "pg_launch",
  type: "slides",
  title: "Q4 Product Deck",
}

describe("OpenArtifactSheet", () => {
  beforeEach(() => {
    themeState.resolvedTheme = "light"
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("validates allowedOrigins, mounts iframe, toggles fullscreen without remounting, and syncs host_hello theme", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      embedUrl: "https://oa.alook.ai/a/pg_launch?v=1",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })

    const onOpenChange = vi.fn()
    const view = renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />,
    )

    const frame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    expect(frame.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?v=1")
    expect(frame.getAttribute("sandbox")).toBe(OPEN_ARTIFACT_SANDBOX)
    expect(frame.getAttribute("sandbox")).not.toBe(HTML_PREVIEW_SANDBOX)

    const sheet = screen.getByTestId(tid.openArtifactSheet)
    expect(sheet.getAttribute("data-fullscreen")).toBe("false")
    fireEvent.click(screen.getByTestId(tid.openArtifactFullscreen))
    expect(sheet.getAttribute("data-fullscreen")).toBe("true")
    expect(screen.getByTestId(tid.openArtifactFrame)).toBe(frame)

    const postMessage = vi.fn()
    const fakeWindow = { postMessage } as unknown as Window
    Object.defineProperty(frame, "contentWindow", { value: fakeWindow, configurable: true })

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://evil.example",
        source: fakeWindow,
        data: { openArtifact: "shell_hello", version: "1", protocol: 1, artifact: "p", id: "pg_launch", title: "Deck", type: "slides" },
      }))
    })
    expect(postMessage).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://oa.alook.ai",
        source: fakeWindow,
        data: { openArtifact: "shell_hello", version: "1", protocol: 1, artifact: "p", id: "pg_launch", title: "Deck", type: "slides" },
      }))
    })
    expect(postMessage).toHaveBeenCalledWith(
      {
        openArtifact: "host_hello",
        protocol: OPEN_ARTIFACT_HOST_PROTOCOL,
        caps: { toolbar: true, switcher: true },
        theme: { scheme: "light" },
      },
      "https://oa.alook.ai",
    )

    themeState.resolvedTheme = "dark"
    view.rerender(
      <OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />,
    )

    await waitFor(() => {
      expect(postMessage).toHaveBeenLastCalledWith(
        {
          openArtifact: "host_hello",
          protocol: OPEN_ARTIFACT_HOST_PROTOCOL,
          caps: { toolbar: true, switcher: true },
          theme: { scheme: "dark" },
        },
        "https://oa.alook.ai",
      )
    })
  })

  it("blocks untrusted origins without mounting an iframe", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      embedUrl: "https://untrusted.example/a/pg_launch",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })

    renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={vi.fn()} />,
    )

    await waitFor(() => {
      expect(screen.getByTestId(tid.openArtifactStatus).textContent).toContain("Blocked untrusted page")
    })
    expect(screen.queryByTestId(tid.openArtifactFrame)).toBeNull()
  })

  it("renders dedicated revoked UI on 404 without mounting an iframe", async () => {
    vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new ApiError("Page not found", 404))

    renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={vi.fn()} />,
    )

    const revoked = await waitFor(() => screen.getByTestId(tid.openArtifactRevoked))
    expect(revoked.textContent).toContain("Access unavailable")
    expect(screen.queryByTestId(tid.openArtifactFrame)).toBeNull()
  })

  it("shows retryable host error on 503 and recovers after clicking Retry", async () => {
    const spy = vi.spyOn(apiClient, "apiFetch")
    spy.mockRejectedValueOnce(new ApiError("Host unavailable", 503))
    spy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch?retry=1",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })

    renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={vi.fn()} />,
    )

    const retryButton = await waitFor(() => screen.getByTestId(tid.openArtifactRetry))
    expect(screen.queryByTestId(tid.openArtifactFrame)).toBeNull()

    fireEvent.click(retryButton)
    const frame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    expect(frame.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?retry=1")
  })

  it("guards closing when leaveLosesWork is reported and posts positioned comments", async () => {
    const fetchSpy = vi.spyOn(apiClient, "apiFetch")
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })
    fetchSpy.mockResolvedValueOnce({ id: "m_comment_1", seq: 15 })

    const onOpenChange = vi.fn()
    renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />,
    )

    const frame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    const fakeWindow = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, "contentWindow", { value: fakeWindow, configurable: true })

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://oa.alook.ai",
        source: fakeWindow,
        data: { openArtifact: "place", artifact: "pg_launch", hash: "#slide-3" },
      }))
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://oa.alook.ai",
        source: fakeWindow,
        data: { openArtifact: "saved", state: "unsaved", leaveLosesWork: true },
      }))
    })

    expect(screen.getByTestId(tid.openArtifactStatus).textContent).toContain("Unsaved changes")

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://oa.alook.ai",
        source: fakeWindow,
        data: { openArtifact: "comment_summon", text: "Already sent by OA host" },
      }))
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId(tid.openArtifactCommentTrigger))
    const input = await waitFor(() => screen.getByTestId(tid.openArtifactCommentInput))
    fireEvent.change(input, { target: { value: "Clarify chart subtitle" } })
    fireEvent.click(screen.getByTestId(tid.openArtifactCommentSubmit))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/community/pages/pg_launch/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Clarify chart subtitle", location: "#slide-3" }),
        signal: undefined,
      })
    })

    fireEvent.click(screen.getByLabelText("Close page"))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByText("Unsaved changes may be lost if you close now.")).toBeTruthy()
    fireEvent.click(screen.getByText("Close anyway"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("resets stale leaveLosesWork and confirmClose state when switching to another page while open", async () => {
    const fetchSpy = vi.spyOn(apiClient, "apiFetch")
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_next",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:05:00Z",
    })

    const onOpenChange = vi.fn()
    const view = renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />,
    )

    const frame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    const fakeWindow = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(frame, "contentWindow", { value: fakeWindow, configurable: true })

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://oa.alook.ai",
        source: fakeWindow,
        data: { openArtifact: "saved", state: "unsaved", leaveLosesWork: true },
      }))
    })

    fireEvent.click(screen.getByLabelText("Close page"))
    expect(screen.getByText("Unsaved changes may be lost if you close now.")).toBeTruthy()

    const nextPage = { kind: "alook_page" as const, id: "pg_next", type: "doc", title: "Next Brief" }
    view.rerender(<OpenArtifactSheet page={nextPage} open onOpenChange={onOpenChange} />)

    await waitFor(() => {
      expect((screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement).getAttribute("src"))
        .toBe("https://oa.alook.ai/a/pg_next")
    })
    expect(screen.queryByText("Unsaved changes may be lost if you close now.")).toBeNull()

    fireEvent.click(screen.getByLabelText("Close page"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("does not refetch one-time viewer token on window focus or reconnect, and fetches a fresh ticket on reopen", async () => {
    const fetchSpy = vi.spyOn(apiClient, "apiFetch")
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch?ticket=first",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch?ticket=second",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:05:00Z",
    })

    const onOpenChange = vi.fn()
    const view = renderCommunity(
      <OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />,
    )

    const initialFrame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    expect(initialFrame.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?ticket=first")
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      window.dispatchEvent(new Event("focus"))
      window.dispatchEvent(new Event("online"))
      document.dispatchEvent(new Event("visibilitychange"))
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(tid.openArtifactFrame)).toBe(initialFrame)
    expect(initialFrame.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?ticket=first")

    view.rerender(<OpenArtifactSheet page={null} open={false} onOpenChange={onOpenChange} />)
    view.rerender(<OpenArtifactSheet page={samplePage} open onOpenChange={onOpenChange} />)

    const reopenedFrame = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(reopenedFrame.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?ticket=second")
  })

  it("forwards sourceMessageId to viewer-token and comments, and refreshes when switching source messages for the same page", async () => {
    const fetchSpy = vi.spyOn(apiClient, "apiFetch")
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch?src=msg_a",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })
    fetchSpy.mockResolvedValueOnce({ id: "m_comment_a", seq: 21 })
    fetchSpy.mockResolvedValueOnce({
      embedUrl: "https://oa.alook.ai/a/pg_launch?src=msg_b",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:05:00Z",
    })

    const onOpenChange = vi.fn()
    const view = renderCommunity(
      <OpenArtifactSheet
        page={{ ...samplePage, sourceMessageId: "msg_a" }}
        open
        onOpenChange={onOpenChange}
      />,
    )

    const frameA = await waitFor(() => screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement)
    expect(frameA.getAttribute("src")).toBe("https://oa.alook.ai/a/pg_launch?src=msg_a")
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/community/pages/pg_launch/viewer-token", {
      method: "POST",
      body: JSON.stringify({ sourceMessageId: "msg_a" }),
      signal: expect.any(AbortSignal),
    })

    fireEvent.click(screen.getByTestId(tid.openArtifactCommentTrigger))
    const input = await waitFor(() => screen.getByTestId(tid.openArtifactCommentInput))
    fireEvent.change(input, { target: { value: "Reply to channel A" } })
    fireEvent.click(screen.getByTestId(tid.openArtifactCommentSubmit))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenNthCalledWith(2, "/api/community/pages/pg_launch/comments", {
        method: "POST",
        body: JSON.stringify({ text: "Reply to channel A", sourceMessageId: "msg_a" }),
        signal: undefined,
      })
    })

    view.rerender(
      <OpenArtifactSheet
        page={{ ...samplePage, sourceMessageId: "msg_b" }}
        open
        onOpenChange={onOpenChange}
      />,
    )

    await waitFor(() => {
      expect((screen.getByTestId(tid.openArtifactFrame) as HTMLIFrameElement).getAttribute("src"))
        .toBe("https://oa.alook.ai/a/pg_launch?src=msg_b")
    })
    expect(fetchSpy).toHaveBeenNthCalledWith(3, "/api/community/pages/pg_launch/viewer-token", {
      method: "POST",
      body: JSON.stringify({ sourceMessageId: "msg_b" }),
      signal: expect.any(AbortSignal),
    })
  })
})
