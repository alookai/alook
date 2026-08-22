import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMeetingCallback } from "./meeting-callback.js"

const input = {
  meetingId: "meeting-1",
  workspaceId: "workspace-1",
  callbackUrl: "https://alook.example",
  authToken: "token-1",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("sendMeetingCallback", () => {
  it("returns successful callback responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const response = await sendMeetingCallback(input, "completed", "Speaker: hello")

    expect(response.status).toBe(204)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://alook.example/api/meeting/callback",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          meetingId: "meeting-1",
          workspaceId: "workspace-1",
          status: "completed",
          transcript: "Speaker: hello",
        }),
      },
    )
  })

  it("rejects non-success responses with their status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("callback unavailable", { status: 503 })),
    )

    await expect(sendMeetingCallback(input, "failed", undefined, "meeting failed"))
      .rejects.toThrow("HTTP 503: callback unavailable")
  })

  it("preserves the status when an error response body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockRejectedValue(new Error("body stream failed")),
      }),
    )

    await expect(sendMeetingCallback(input, "completed"))
      .rejects.toThrow("HTTP 500")
  })
})
