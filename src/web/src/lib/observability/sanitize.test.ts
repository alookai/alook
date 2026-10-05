import { describe, expect, it } from "vitest"
import type { TransportItem } from "@grafana/faro-web-sdk"
import { sanitizeItem, sanitizeTrace } from "./sanitize"
import { cleanAttributes } from "./schema"
import { routeTemplate } from "./coverage"

const origin = "https://alook.ai", session = "safe-session"
const meta = { sdk: { name: "faro-web", version: "2.12.1", integrations: [{ name: "SECRET", version: "SECRET" }] }, session: { id: session }, page: { url: origin + "/c/invite/SECRET?token=SECRET#SECRET" }, user: { email: "private@example.com", fullName: "SECRET" } }
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
  it("omits absent IDs rather than manufacturing undefined or null receipts", () => {
    expect(cleanAttributes({ ws_event_id: undefined, action_id: null, request_id: "real-receipt" })).toEqual({ request_id: "real-receipt" })
  })
  it("retains the collector-required native SDK contract while rejecting missing or arbitrary SDK metadata", () => {
    const item = { type: "event", meta, payload: { name: "business.result", timestamp: "2026-10-05T00:00:00Z", attributes: { outcome: "success" } } } as TransportItem
    const clean = sanitizeItem(item, session, origin)!
    expect(clean.meta.sdk).toEqual({ name: "faro-web", version: "2.12.1" })
    expect(JSON.stringify(clean)).not.toContain("SECRET")
    for (const sdk of [undefined, { name: "faro-web" }, { name: "SECRET", version: "2.12.1" }, { name: "faro-web", version: "SECRET" }]) {
      expect(sanitizeItem({ ...item, meta: { ...meta, sdk } }, session, origin)).toBeNull()
    }
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
  it("omits unknown HTTP methods without changing internal or real HTTP span identity", () => {
    const base = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "dm.message.send", kind: 1, startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000" }
    const clean = (method?: unknown, legacy = false) => sanitizeTrace({ resourceSpans: [{ scopeSpans: [{ spans: [{
      ...base, attributes: [
        { key: "session.id", value: { stringValue: session } },
        { key: "http.url", value: { stringValue: origin + "/api/community/channels/PRIVATE/messages" } },
        { key: "route_template", value: { stringValue: "/PRIVATE" } },
        ...(method === undefined ? [] : [{ key: legacy ? "http.method" : "http.request.method", value: { stringValue: method } }]),
      ],
    }] }] }] }, session, origin)!.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    for (const method of [undefined, null, "", "undefined", "PRIVATE", "CONNECT"]) {
      const span = clean(method)
      expect(span.name).toBe("dm.message.send")
      expect(span.kind).toBe(1)
      expect(span.traceId).toBe(base.traceId)
      expect(span.spanId).toBe(base.spanId)
      expect(span.attributes).toContainEqual({ key: "route_template", value: { stringValue: "/api/community/channels/[id]/messages" } })
      expect(JSON.stringify(span)).not.toContain("PRIVATE")
      expect(span.attributes.some(attribute => attribute.key === "http.request.method")).toBe(false)
    }
    for (const legacy of [false, true]) {
      const span = clean("POST", legacy)
      expect(span.attributes).toContainEqual({ key: "http.request.method", value: { stringValue: "POST" } })
    }
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

  it("retains only known native action names and finite nonnegative action timings", () => {
    const item = (attributes: Record<string, string>) => ({ type: "event", meta, payload: { name: "faro.user.action", timestamp: "2026-10-05T00:00:00Z", attributes } }) as TransportItem
    const clean = sanitizeItem(item({ userActionName: "ui_interaction", userActionDuration: "12", userActionStartTime: "0", userActionEndTime: "Infinity", private: "SECRET" }), session, origin)!
    expect(clean.payload).toMatchObject({ attributes: { userActionName: "ui_interaction", userActionDuration: "12", userActionStartTime: "0" } })
    expect(JSON.stringify(clean)).not.toContain("Infinity")
    expect(JSON.stringify(clean)).not.toContain("SECRET")
    expect(sanitizeItem(item({ userActionName: "SECRET" }), session, origin)).toBeNull()
    expect(sanitizeItem(item({}), session, origin)).toBeNull()
  })
  it("accepts whitelisted web vitals, rejects arbitrary measurements and invalid stack URLs", () => {
    const measurement = (type: string, values: Record<string, number>) => ({ type: "measurement", meta, payload: { type, timestamp: "2026-10-05T00:00:00Z", values } }) as TransportItem
    expect(sanitizeItem(measurement("web-vitals", { LCP: 10, cls: 0, SECRET: 1, inp: NaN, fcp: -1 }), session, origin)?.payload).toEqual({ type: "web-vitals", timestamp: "2026-10-05T00:00:00Z", values: { LCP: 10, cls: 0 } })
    expect(sanitizeItem(measurement("arbitrary", { LCP: 10 }), session, origin)).toBeNull()
    expect(sanitizeItem(measurement("web-vitals", { SECRET: 1 }), session, origin)).toBeNull()
    const exception = { type: "exception", meta, payload: { type: "Error", value: "SECRET", stacktrace: { frames: [{ filename: "http://[", lineno: 3 }] } } } as TransportItem
    expect(sanitizeItem(exception, session, origin)?.payload).toMatchObject({ value: "[redacted]", stacktrace: { frames: [] } })
    expect(sanitizeItem({ type: "unknown", meta, payload: {} } as unknown as TransportItem, session, origin)).toBeNull()
  })

})
