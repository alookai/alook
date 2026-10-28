import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { channelResourceFixture } from "@/test/community-resource-fixtures"
import { createApplicationOwner, captureApplicationOwner, assertApplicationOwner, retireApplicationOwner } from "@/lib/application-owner"
import * as lifecycle from "@/lib/business-schema-lifecycle"
import { apiFetch } from "./client"

beforeEach(() => {
  lifecycle.businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
  vi.stubGlobal("window", { location: { href: `https://alook.test/c/me?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}` } })
  vi.stubGlobal("navigator", {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const resource = () => ({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", channel: channelResourceFixture({ id: "channel" }),
  access: { channelId: "channel", canRead: true, canSend: true, canCreateDiscussion: true } })
const kinds = ["json", "resource", "abort", "error-json", "error-resource", "error-abort"] as const

async function bodyCase(kind: typeof kinds[number] | "valid", mode: "active" | "retired" | "aborted") {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), {
    status: kind.startsWith("error-") ? 400 : 200,
    headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
  })
  const json = response.json.bind(response)
  vi.spyOn(response, "json").mockImplementation(() => { start(); return json() })
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
      const body = kind === "valid" ? JSON.stringify(resource()) : kind.endsWith("json") ? "{bad-json" : JSON.stringify({ ...resource(), channel: { id: "channel" } })
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
