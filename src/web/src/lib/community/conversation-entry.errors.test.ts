import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONVERSATION_ANCHOR_MISSING } from "@alook/shared"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { protectCommunityJsonResponse } from "@/lib/middleware/response-cache"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { conversationEntryOptions } from "./conversation-entry"
import { isConversationAnchorMissingError } from "./conversation-read"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function respond(status: number, error: string, details?: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => protectCommunityJsonResponse(
    new Request(new URL(path, "https://alook.test"), options), Response.json({ error, ...(details ? { details } : {}) }, { status }),
  )))
}

describe("current error semantics through middleware, API client and entry", () => {
  it.each(["anchor", "forbidden", "missing"] as const)("preserves %s access semantics after the actual error response boundary", async mode => {
    const { client, registry } = await createCommunityQueryOwner()
    await seedConversationEntry(client, conversationEntryFixture())
    respond(mode === "forbidden" ? 403 : 404, mode === "anchor" ? "anchor not found" : "channel not available",
      mode === "anchor" ? [COMMUNITY_CONVERSATION_ANCHOR_MISSING] : undefined)
    const failure = await client.query({ ...conversationEntryOptions(client, { channelId: "c1", serverId: "s1", anchorMessageId: "deleted" }), retry: false, select: undefined }).then(
      () => { throw new Error("Expected entry failure") }, error => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect(isConversationAnchorMissingError(failure)).toBe(mode === "anchor")
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(mode !== "anchor")
    if (mode === "anchor") expect(registry.collections.messages.get("m1")?.content).toBe("Body")
  })

  it("keeps current validation details and their readable error message", async () => {
    respond(400, "validation error", ["name: Too long"])
    const failure = await apiFetch("/api/community/servers", { method: "POST", body: JSON.stringify({ name: "invalid" }) }).then(
      () => { throw new Error("Expected validation failure") }, error => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.details).toEqual(["name: Too long"])
    expect(failure.message).toBe("Name Too long")
  })
})
