import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONVERSATION_ANCHOR_MISSING, BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityReadErrorSchema } from "@alook/shared"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { protectCommunityJsonResponse } from "@/lib/middleware/response-cache"
import { apiFetch } from "@/lib/api/client"
import { ApiError, CommunityApiError } from "@/lib/errors"
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

it.each([["blocked",403],["not_allowed",403],["not_found",404]] as const)("hands the actual %s error to the current scope before query generation retirement",async(code,status)=>{
  const {client,registry}=await createCommunityQueryOwner()
  const value=code==="blocked" ? dmConversationEntryFixture() : conversationEntryFixture()
  await seedConversationEntry(client,value)
  const {captureCommunityLiveSnapshotToken,publishCommunityMessages}=await import("@/lib/community-db/sync")
  const obsolete=captureCommunityLiveSnapshotToken(client,value.channelId)
  const payload=CommunityReadErrorSchema.parse({contractVersion:BUSINESS_SCHEMA_VERSION,error:{code,message:code,retryable:false}})
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json",[COMMUNITY_CONTRACT_HEADER]:String(BUSINESS_SCHEMA_VERSION)}})))
  const failure=await client.query({...conversationEntryOptions(client,{channelId:value.channelId,serverId:value.channel.serverId}),retry:false,staleTime:0,select:undefined}).catch(error=>error)
  expect(failure).toBeInstanceOf(CommunityApiError)
  expect(failure.code).toBe(code)
  const scope=registry.runtime.ws.get().channelAccessScopes.get(value.channelId)!
  expect(scope).toMatchObject({revoked:true,denialCode:code})
  expect(scope.generation).toBeGreaterThan(obsolete.channelScopes.get(value.channelId)?.generation ?? 0)
  expect(registry.collections.messages.has("m1")).toBe(false)
  expect(()=>publishCommunityMessages(client,{channelId:value.channelId,messages:value.messages,profiles:value.profiles,proof:{token:obsolete}})).toThrow()
})
