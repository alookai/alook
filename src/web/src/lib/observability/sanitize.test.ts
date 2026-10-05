import { describe, expect, it } from "vitest"
import type { TransportItem } from "@grafana/faro-web-sdk"
import { sanitizeItem, sanitizeTrace } from "./sanitize"
import { cleanAttributes } from "./schema"
import { routeTemplate } from "./coverage"

const origin = "https://alook.ai", session = "safe-session"
const meta = { session: { id: session }, page: { url: origin + "/c/invite/SECRET?token=SECRET#SECRET" }, user: { email: "private@example.com", fullName: "SECRET" } }
describe("outbound whitelist", () => {
  it("templates IDs, never exposes query or external arbitrary URLs", () => {
    expect(routeTemplate("/c/invite/SECRET?token=SECRET", origin)).toBe("/c/invite/[token]")
    expect(routeTemplate("/api/community/messages/SECRET/reactions/PRIVATE", origin)).toBe("/api/community/messages/[id]/reactions/[emoji]")
    expect(routeTemplate("https://private.example/SECRET", origin)).toBe("/external")
    expect(routeTemplate("/random/SECRET", origin)).toBe("/unmapped")
  })
  it("drops console text and all arbitrary business attributes", () => {
    expect(sanitizeItem({ type: "log", meta, payload: { message: "SECRET" } } as TransportItem, session, origin)).toBeNull()
    expect(cleanAttributes({ content: "SECRET", filename: "SECRET", token: "SECRET", action_name: "SECRET", route_template: "/c/SECRET" })).toEqual({})
  })
  it("rebuilds automatic errors and metadata", () => {
    const item = { type: "exception", meta, payload: { type: "TypeError", value: "SECRET", timestamp: "2026-10-05T00:00:00Z", context: { token: "SECRET" }, originalError: new Error("SECRET"), stacktrace: { frames: [
      { filename: origin + "/_next/static/chunks/abcdef.js?token=SECRET", function: "SECRET", lineno: 10 },
      { filename: "https://private.example/SECRET", function: "SECRET" },
    ] } } } as TransportItem
    const clean = sanitizeItem(item, session, origin)
    expect(JSON.stringify(clean)).not.toContain("SECRET")
    expect(JSON.stringify(clean)).not.toContain("private@example.com")
    expect(JSON.stringify(clean)).toContain("/c/invite/[token]")
    expect(sanitizeItem(item, "different-session", origin)).toBeNull()
  })
  it("rebuilds traces, removes events/status messages/attributes and rejects retired spans", () => {
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "SECRET", kind: 3, startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", status: { code: 2, message: "SECRET" }, events: [{ name: "SECRET" }], links: [{ attributes: "SECRET" }], attributes: [
      { key: "session.id", value: { stringValue: session } },
      { key: "http.url", value: { stringValue: origin + "/api/community/messages/SECRET?token=SECRET" } },
      { key: "authorization", value: { stringValue: "SECRET" } },
    ] }
    const clean = sanitizeTrace({ resourceSpans: [{ resource: { attributes: [{ key: "secret", value: "SECRET" }] }, scopeSpans: [{ scope: { name: "SECRET" }, spans: [span] }] }] }, session, origin)
    expect(JSON.stringify(clean)).not.toContain("SECRET")
    expect(JSON.stringify(clean)).toContain("/api/community/messages/[id]")
    expect(sanitizeTrace({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }, "new-session", origin)).toBeNull()
  })
  it("accepts installed native HTTP mirror names and rejects old span-start sessions", () => {
    const item = { type: "event", meta, payload: { name: "faro.tracing.fetch", timestamp: "2026-10-05T00:00:00Z", attributes: { "session.id": session, "http.url": origin + "/api/community/messages/SECRET?token=SECRET", "http.method": "PATCH", duration_ns: "2000000" } } } as TransportItem
    const clean = sanitizeItem(item, session, origin)
    expect(clean).not.toBeNull()
    expect(JSON.stringify(clean)).toContain("/api/community/messages/[id]")
    expect(JSON.stringify(clean)).not.toContain("SECRET")
    const old = { ...item, payload: { ...item.payload, attributes: { "session.id": "old-session" } } } as TransportItem
    expect(sanitizeItem(old, session, origin)).toBeNull()
  })

})
