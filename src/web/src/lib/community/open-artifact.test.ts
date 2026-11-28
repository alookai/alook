import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import * as apiClient from "@/lib/api/client"
import {
  buildPageCoverUrl,
  classifyPageViewerError,
  describePageSaveState,
  describePageType,
  extractAlookPagesFromEmbeds,
  fetchPageViewerToken,
  resolvePageHostPreconnectOrigin,
  submitPageComment,
} from "./open-artifact"

describe("open-artifact", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("extracts deduplicated alook_page embeds and preserves unrelated embeds", () => {
    const page1 = { kind: "alook_page", id: "pg_1", type: "doc", title: "Launch brief" }
    const page1Dup = { kind: "alook_page", id: "pg_1", type: "doc", title: "Launch brief" }
    const pageInvalid = { kind: "alook_page", id: "", type: "doc", title: "Broken" }
    const link = { title: "Docs", url: "https://example.com" }

    const result = extractAlookPagesFromEmbeds([page1, page1Dup, pageInvalid, link])
    expect(result.pages).toEqual([page1])
    expect(result.otherEmbeds).toEqual([link])
  })

  it("classifies 401, 404/403/410, 503, and generic errors cleanly", () => {
    expect(classifyPageViewerError(new ApiError("Unauthorized", 401))).toMatchObject({
      kind: "unauthenticated",
      retryable: false,
    })
    expect(classifyPageViewerError(new ApiError("Not found", 404))).toMatchObject({
      kind: "revoked",
      retryable: false,
    })
    expect(classifyPageViewerError(new ApiError("Unavailable", 503))).toMatchObject({
      kind: "unavailable",
      retryable: true,
    })
    expect(classifyPageViewerError(new Error("Network down"))).toMatchObject({
      kind: "error",
      description: "Network down",
      retryable: true,
    })
  })

  it("formats page types and save states in natural sentence case", () => {
    expect(describePageType("doc")).toEqual({ kind: "doc", label: "Document" })
    expect(describePageType("slides")).toEqual({ kind: "slides", label: "Slides" })
    expect(describePageType("design_board")).toEqual({ kind: "other", label: "Design board" })
    expect(describePageSaveState("saved")).toBe("Saved")
    expect(describePageSaveState("unsaved")).toBe("Unsaved changes")
    expect(describePageSaveState(null)).toBeNull()
  })

  it("builds encoded page cover URLs with optional sourceMessageId", () => {
    expect(buildPageCoverUrl("pg/1")).toBe("/api/community/pages/pg%2F1/cover")
    expect(buildPageCoverUrl("pg_1", "  ")).toBe("/api/community/pages/pg_1/cover")
    expect(buildPageCoverUrl("pg_1", " msg/42 ")).toBe("/api/community/pages/pg_1/cover?sourceMessageId=msg%2F42")
  })

  it("calls POST /api/community/pages/:id/viewer-token with optional sourceMessageId and validates the payload", async () => {
    const spy = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      embedUrl: "https://oa.alook.ai/a/pg_1?token=short",
      allowedOrigins: ["https://oa.alook.ai"],
      expiresAt: "2026-11-27T13:00:00Z",
    })

    const res = await fetchPageViewerToken("pg/1")
    expect(spy).toHaveBeenCalledWith("/api/community/pages/pg%2F1/viewer-token", {
      method: "POST",
      signal: undefined,
    })
    expect(res.embedUrl).toBe("https://oa.alook.ai/a/pg_1?token=short")

    await fetchPageViewerToken("pg_1", { sourceMessageId: " msg_42 " })
    expect(spy).toHaveBeenLastCalledWith("/api/community/pages/pg_1/viewer-token", {
      method: "POST",
      body: JSON.stringify({ sourceMessageId: "msg_42" }),
      signal: undefined,
    })
  })

  it("calls POST /api/community/pages/:id/comments with trimmed text, location, and optional sourceMessageId", async () => {
    const spy = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ id: "m_1", seq: 12 })

    await submitPageComment("pg_1", {
      text: "  Tighten slide 2  ",
      location: " #slide-2 ",
      sourceMessageId: " msg_99 ",
    })
    expect(spy).toHaveBeenCalledWith("/api/community/pages/pg_1/comments", {
      method: "POST",
      body: JSON.stringify({ text: "Tighten slide 2", location: "#slide-2", sourceMessageId: "msg_99" }),
      signal: undefined,
    })

    await submitPageComment("pg_1", { text: "Looks good" })
    expect(spy).toHaveBeenLastCalledWith("/api/community/pages/pg_1/comments", {
      method: "POST",
      body: JSON.stringify({ text: "Looks good" }),
      signal: undefined,
    })
  })

  it("resolves Page host preconnect origin from explicit env or production alook.ai hostnames only", () => {
    expect(resolvePageHostPreconnectOrigin({ envOrigin: "https://pages.staging.invalid" })).toBe("https://pages.staging.invalid")
    expect(resolvePageHostPreconnectOrigin({ envOrigin: "javascript:alert(1)" })).toBeNull()
    expect(resolvePageHostPreconnectOrigin({ hostname: "alook.ai" })).toBe("https://page.alook.ai")
    expect(resolvePageHostPreconnectOrigin({ hostname: "app.alook.ai" })).toBe("https://page.alook.ai")
    expect(resolvePageHostPreconnectOrigin({ hostname: "localhost" })).toBeNull()
    expect(resolvePageHostPreconnectOrigin({ hostname: "evil-alook.ai" })).toBeNull()
  })
})
