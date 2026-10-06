import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { apiFetch, readUploadError } from "./client"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "../observability/telemetry"

const fetch = vi.fn(), events: Array<{ name: string; attributes: Record<string, string> }> = []
beforeEach(() => { fetch.mockReset(); events.length = 0; vi.stubGlobal("fetch", fetch); configureTelemetry({ session_id: "consumer-session" }, true); installTelemetrySink(event => events.push(event)) })
afterEach(() => { retireTelemetry(); vi.unstubAllGlobals() })

it("preserves live multipart JSON parsing, owner checks and sanitized diagnostics", async () => {
  const result = { file: { id: "file-a" } }, assertActive = vi.fn()
  fetch.mockResolvedValue(Response.json(result))
  const body = new FormData()
  body.set("file", new File(["private-file-body"], "private.txt"))
  expect(await apiFetch("/api/community/channels/channel-a/attachments", { method: "POST", body, assertActive })).toEqual(result)
  expect(fetch).toHaveBeenCalledWith("/api/community/channels/channel-a/attachments", expect.objectContaining({ method: "POST", body }))
  expect(assertActive).toHaveBeenCalled()
  expect(events.some(event => event.name === "request.body_parsed" && event.attributes.route_template === "/api/community/channels/[id]/attachments")).toBe(true)
  expect(JSON.stringify(events)).not.toMatch(/private-(?:file|body)/)
})
it("retains shared upload errors without including the response body in telemetry", async () => {
  const error = await readUploadError(Response.json({ error: "private-upload-error" }, { status: 413 }), "Upload failed")
  expect(error.status).toBe(413)
  expect(error.message).toBe("private-upload-error")
  expect(JSON.stringify(events)).not.toContain("private-upload-error")
})
