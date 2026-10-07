import { describe, expect, it } from "vitest"
import { COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { protectCommunityJsonResponse, rejectUnknownCommunityContract } from "./response-cache"

describe("protected community JSON policy", () => {
  it.each([200, 400, 401, 403, 404, 409, 429, 500, 503])("protects status %s and preserves cookies and vary", async (status) => {
    const request = new Request("https://alook.test/api/community/channels/c/messages", { headers: { [COMMUNITY_CONTRACT_HEADER]: "2" } })
    const response = await protectCommunityJsonResponse(request, Response.json(status === 200 ? { value: 1 } : { error: "blocked" }, { status,
      headers: { "Vary": "Origin, cookie", "Cache-Control": "public, max-age=600", "ETag": "old", "Last-Modified": "old", "Set-Cookie": "session=refreshed; HttpOnly" } }))
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(response.headers.get("Vary")).toBe("Origin, cookie, X-Alook-Community-Contract, Authorization")
    expect(response.headers.get("ETag")).toBeNull()
    expect(response.headers.get("Last-Modified")).toBeNull()
    expect(response.headers.get("Set-Cookie")).toBe("session=refreshed; HttpOnly")
    if (status !== 200) expect(await response.json()).toMatchObject({ contractVersion: 2, error: { message: "blocked", retryable: status >= 500 || status === 429 } })
  })
  it("preserves the independent media policy and rejects unknown versions", async () => {
    const request = new Request("https://alook.test/api/community/channels/c/icon", { headers: { [COMMUNITY_CONTRACT_HEADER]: "3" } })
    const image = new Response("image", { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "ETag": "asset" } })
    expect(await protectCommunityJsonResponse(request, image)).toBe(image)
    expect(rejectUnknownCommunityContract(request)?.status).toBe(400)
    expect(rejectUnknownCommunityContract(new Request("https://alook.test/api/calendar", { headers: { [COMMUNITY_CONTRACT_HEADER]: "3" } }))).toBeNull()
  })
})
