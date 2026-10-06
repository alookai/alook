import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { getArtifactContent } from "./artifacts"
import { createIssue } from "./issues"
import { sendMessage } from "./conversations"
import { uploadEmailAttachment } from "./emails"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "../observability/telemetry"

const fetch = vi.fn(), events: Array<{ name: string; attributes: Record<string, string> }> = []
beforeEach(() => { fetch.mockReset(); events.length = 0; vi.stubGlobal("fetch", fetch); configureTelemetry({ session_id: "consumer-session" }, true); installTelemetrySink(event => events.push(event)) })
afterEach(() => { retireTelemetry(); vi.unstubAllGlobals() })
it("returns artifact text after observed parsing and preserves active owner checks", async () => {
  fetch.mockResolvedValue(new Response("private-artifact-body"))
  const assertActive = vi.fn()
  expect(await getArtifactContent("artifact-a", "workspace-a", { assertActive })).toBe("private-artifact-body")
  expect(fetch).toHaveBeenCalledWith("/api/artifacts/artifact-a/content?workspace_id=workspace-a", expect.any(Object))
  expect(assertActive).toHaveBeenCalled()
  expect(events.some(event => event.name === "request.body_parsed" && event.attributes.route_template === "/api/artifacts/[id]/content")).toBe(true)
  expect(JSON.stringify(events)).not.toContain("private-artifact-body")
})
it("preserves multipart issue and conversation responses through observed JSON parsing", async () => {
  const issue = { issue: { id: "issue-a" } }, message = { message: { id: "message-a" }, task: { id: "task-a" } }
  fetch.mockResolvedValueOnce(Response.json(issue)).mockResolvedValueOnce(Response.json(message))
  const file = new File(["private-file-body"], "private.txt", { type: "text/plain" })
  expect(await createIssue("workspace-a", { title: "private-title", agent_id: "agent-a", files: [file] })).toEqual(issue)
  expect(await sendMessage("conversation-a", "private-message", "workspace-a", [{ file, thumbnailUrl: null, thumbnailBlob: null }])).toEqual(message)
  expect(fetch.mock.calls.every(([, options]) => options.method === "POST" && options.body instanceof FormData)).toBe(true)
  expect(events.filter(event => event.name === "request.body_parsed")).toHaveLength(2)
  expect(JSON.stringify(events)).not.toMatch(/private-(?:file|message|title)/)
})
it("retains email upload status and text failure without leaking its body", async () => {
  fetch.mockResolvedValue(new Response("private-upload-error", { status: 413 }))
  await expect(uploadEmailAttachment(new File(["private"], "private.txt"), "workspace-a")).rejects.toMatchObject({ status: 413, message: "private-upload-error" })
  expect(JSON.stringify(events)).not.toContain("private-upload-error")
})
