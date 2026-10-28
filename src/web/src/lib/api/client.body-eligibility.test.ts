import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityReadErrorSchema } from "@alook/shared"
import { channelResourceFixture } from "@/test/community-resource-fixtures"
import { createApplicationOwner, captureApplicationOwner, assertApplicationOwner, retireApplicationOwner } from "@/lib/application-owner"
import * as lifecycle from "@/lib/business-schema-lifecycle"
import { apiFetch } from "./client"
import { ApiError, CommunityApiError } from "@/lib/errors"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"

beforeEach(() => {
  lifecycle.businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
  vi.stubGlobal("window", { location: { href: `https://alook.test/c/me?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}` } })
  vi.stubGlobal("navigator", {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const resource = () => ({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", channel: channelResourceFixture({ id: "channel" }),
  access: { channelId: "channel", canRead: true, canSend: true, canCreateDiscussion: true } })
const kinds = ["json", "resource", "abort", "error-json", "error-resource", "error-abort"] as const

async function bodyCase(kind: typeof kinds[number] | "valid" | "error-valid", mode: "active" | "retired" | "aborted") {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), {
    status: kind === "error-valid" ? 403 : kind.startsWith("error-") ? 400 : 200,
    headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
  })
  const text = response.text.bind(response)
  vi.spyOn(response, "text").mockImplementation(() => { start(); return text() })
  vi.stubGlobal("fetch", vi.fn(async () => response))
  const original = createApplicationOwner("original"), next = createApplicationOwner("next")
  const token = captureApplicationOwner(original), abort = new AbortController()
  const upgrade = vi.spyOn(lifecycle, "requestBusinessSchemaUpdate")
  const result = apiFetch("/api/community/channels/channel", { signal: abort.signal, assertActive: () => assertApplicationOwner(token, abort.signal) }).then(
    value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }),
  )
  await started
  if (mode === "retired") retireApplicationOwner(original)
  if (mode === "aborted") abort.abort()
  const protectedOwner = mode === "active" ? original : next
  const unregister = lifecycle.registerBusinessSchemaOwner(async () => { retireApplicationOwner(protectedOwner) })
  try {
    if (kind.endsWith("abort")) controller.error(new DOMException("Body cancelled", "AbortError"))
    else {
      const body = kind === "error-valid" ? JSON.stringify(CommunityReadErrorSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, error: { code: "blocked", message: "blocked", retryable: false } })) : kind === "valid" ? JSON.stringify(resource()) : kind.endsWith("json") ? "{bad-json" : JSON.stringify({ ...resource(), channel: { id: "channel" } })
      controller.enqueue(new TextEncoder().encode(body)); controller.close()
    }
    const completed = await result
    const shouldUpgrade = mode === "active" && !kind.endsWith("abort") && kind !== "valid"
    if (shouldUpgrade) {
      await vi.waitFor(() => expect(lifecycle.businessSchemaLifecycle.get().phase).toBe("failed"))
      expect(upgrade).toHaveBeenCalledOnce()
      expect(completed.error?.name).toBe("BusinessSchemaMismatch")
      expect(protectedOwner.lifecycle.get().active).toBe(false)
    } else {
      expect(completed.error?.name).toBe("AbortError")
      expect(upgrade).not.toHaveBeenCalled()
      expect(next.lifecycle.get().active).toBe(true)
      expect(lifecycle.businessSchemaLifecycle.get().phase).toBe("current")
    }
  } finally { unregister(); original.queryClient.clear(); next.queryClient.clear() }
}

describe("actual API body eligibility before global update", () => {
  it.each(kinds)("keeps a retired owner's late %s body cancelled without retiring its successor", kind => bodyCase(kind, "retired"))
  it.each(kinds)("keeps a signalled late %s body cancelled without retiring its successor", kind => bodyCase(kind, "aborted"))
  it.each(kinds)("calibrates an active owner's %s body against cancellation and protocol failure", kind => bodyCase(kind, "active"))
  it("keeps the existing late valid-body retirement protection", () => bodyCase("valid", "retired"))
})

it("retains an active non-community JSON parse error without starting a business update", async () => {
  const upgrade = vi.spyOn(lifecycle, "requestBusinessSchemaUpdate")
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{bad-json", { headers: { "Content-Type": "application/json" } })))
  await expect(apiFetch("/api/other-resource")).rejects.toBeInstanceOf(SyntaxError)
  expect(upgrade).not.toHaveBeenCalled()
  expect(lifecycle.businessSchemaLifecycle.get().phase).toBe("current")
})

it.each([["blocked",403],["not_allowed",403],["not_found",404],["temporarily_unavailable",503],["rate_limited",429]] as const)("keeps the actual current %s code through the API error boundary",async(code,status)=>{
  const payload=CommunityReadErrorSchema.parse({contractVersion:BUSINESS_SCHEMA_VERSION,error:{code,message:code,retryable:status===429||status>=500,details:["reason detail"]}})
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json",[COMMUNITY_CONTRACT_HEADER]:String(BUSINESS_SCHEMA_VERSION)}})))
  const failure=await apiFetch("/api/community/channels/dm-a/messages?entry=1").catch(error=>error)
  expect(failure).toBeInstanceOf(CommunityApiError)
  expect(failure).toMatchObject({status,code,retryable:status===429||status>=500,details:["reason detail"]})
})
it.each(["retired","aborted"] as const)("rejects a valid late blocked error after its owner is %s",mode=>bodyCase("error-valid",mode))

describe("HTTP body transport failure before complete JSON qualification", () => {
  it.each([200, 403, 404, 503].flatMap(status =>
    (["active", "retired", "aborted"] as const).map(mode => ({ status, mode })),
  ))("keeps $status stream failure with $mode owner out of schema retirement", async ({ status, mode }) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let beginRead!: () => void
    const reading = new Promise<void>(resolve => { beginRead = resolve })
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), {
      status, headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
    })
    const text = response.text.bind(response)
    vi.spyOn(response, "text").mockImplementation(() => { beginRead(); return text() })
    vi.stubGlobal("fetch", vi.fn(async () => response))
    const original = createApplicationOwner("stream-original"), next = createApplicationOwner("stream-next")
    const token = captureApplicationOwner(original), signal = new AbortController()
    const upgrade = vi.spyOn(lifecycle, "requestBusinessSchemaUpdate")
    const result = apiFetch("/api/community/channels/channel", {
      signal: signal.signal, assertActive: () => assertApplicationOwner(token, signal.signal),
    }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))
    await reading
    if (mode === "retired") retireApplicationOwner(original)
    if (mode === "aborted") signal.abort()
    const protectedOwner = mode === "active" ? original : next
    const unregister = lifecycle.registerBusinessSchemaOwner(async () => { retireApplicationOwner(protectedOwner) })
    try {
      controller.error(new TypeError("HTTP body transport disconnected"))
      const { error } = await result
      if (mode !== "active") expect(error?.name).toBe("AbortError")
      else if (status === 200) expect(error).toBeInstanceOf(TypeError)
      else {
        expect(error).toBeInstanceOf(ApiError)
        expect(error).not.toBeInstanceOf(CommunityApiError)
        expect(error).toMatchObject({ status })
        expect(error).not.toHaveProperty("code")
      }
      expect(upgrade).not.toHaveBeenCalled()
      expect(protectedOwner.lifecycle.get().active).toBe(true)
      expect(lifecycle.businessSchemaLifecycle.get().phase).toBe("current")
    } finally { unregister(); original.queryClient.clear(); next.queryClient.clear() }
  })

  it.each([403, 404])("keeps actual entry revocation and removes old body when the %s stream fails", async status => {
    const { client, registry } = await createCommunityQueryOwner()
    await seedConversationEntry(client, conversationEntryFixture())
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError("Denied response body disconnected")) },
    }), { status, headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })))
    const upgrade = vi.spyOn(lifecycle, "requestBusinessSchemaUpdate")
    const failure = await client.query({ ...conversationEntryOptions(client, { channelId: "c1", serverId: "s1" }),
      retry: false, staleTime: 0, select: undefined }).catch(error => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).not.toBeInstanceOf(CommunityApiError)
    expect(failure).toMatchObject({ status })
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(true)
    expect(registry.runtime.ws.get().channelAccessScopes.get("c1")?.denialCode).toBeUndefined()
    expect(registry.collections.messages.has("m1")).toBe(false)
    expect(upgrade).not.toHaveBeenCalled()
    expect(lifecycle.businessSchemaLifecycle.get().phase).toBe("current")
  })
})
