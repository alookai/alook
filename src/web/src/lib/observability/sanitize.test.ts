import { describe, expect, it } from "vitest"
import type { TransportItem } from "@grafana/faro-web-sdk"
import { sanitizeItem, sanitizeTrace } from "./sanitize"
import { cleanAttributes } from "./schema"
import { routeTemplate } from "./coverage"
import { resolveFrontendIdentity } from "./runtime"

const origin = "https://alook.ai", session = "safe-session"
const meta = { sdk: { name: "faro-web", version: "2.12.1", integrations: [{ name: "SECRET", version: "SECRET" }] }, session: { id: session }, page: { url: origin + "/c/invite/SECRET?token=SECRET#SECRET" }, user: { email: "private@example.com", fullName: "SECRET" } }
describe("outbound whitelist", () => {
  it("templates IDs, never exposes query or external arbitrary URLs", () => {
    for (const path of ["/w/private/agents/a/chat/b?token=SECRET", "/w", "/workspaces", "/studio/new?token=SECRET", "/invite/SECRET"]) {
      expect(routeTemplate(path, origin)).toBe("/unmapped")
    }
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
  it("retains real link IDs while rejecting zero IDs and private link metadata", () => {
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "navigation", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000",
      attributes: [{ key: "session.id", value: { stringValue: session } }], links: [
        { traceId: "c".repeat(32), spanId: "d".repeat(16), traceState: "SECRET", attributes: [{ key: "private", value: "SECRET" }] },
        { traceId: "0".repeat(32), spanId: "d".repeat(16) },
        { traceId: "c".repeat(32), spanId: "0".repeat(16) },
      ] }
    const clean = sanitizeTrace({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }, session, origin)!
    expect(clean.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.links).toEqual([{ traceId: "c".repeat(32), spanId: "d".repeat(16), attributes: [], droppedAttributesCount: 0 }])
    expect(JSON.stringify(clean)).not.toContain("SECRET")
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

  it("preserves frontend package version independently of optional release while dropping arbitrary app and session metadata", () => {
    const item = { type: "event", meta: { ...meta, app: { name: "SECRET", version: "0.1.44", release: "a".repeat(40), environment: "qa" }, session: { id: session, attributes: { private: "SECRET" } } }, payload: { name: "session_start", attributes: {} } } as TransportItem
    expect(sanitizeItem(item, session, origin)?.meta.app).toEqual({ name: "alook-web", version: "0.1.44", release: "a".repeat(40), environment: "qa" })
    for (const release of [undefined, "SECRET", "0.1.44"]) {
      const clean = sanitizeItem({ ...item, meta: { ...item.meta, app: { ...item.meta.app, release } } }, session, origin)!
      expect(clean.meta.app).toEqual({ name: "alook-web", version: "0.1.44", environment: "qa" })
      expect(JSON.stringify(clean)).not.toContain("SECRET")
    }
    const invalid = sanitizeItem({ ...item, meta: { ...item.meta, app: { version: "SECRET" } } }, session, origin)!
    expect(invalid.meta.app?.version).toBeUndefined()
  })

  it("carries canonical entry and frontend version on SDK events, vitals, errors and trace resources without accepting a spoofed payload", () => {
    const identity = { frontend_surface: "webview", client_platform: "desktop", app_version: "0.1.44" } as const
    const spoofed = { frontend_surface: "web", client_platform: "browser", app_version: "9.9.9", private: "SECRET" }
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "dm.message.send", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", attributes: [{ key: "session.id", value: { stringValue: session } }, ...Object.entries(spoofed).map(([key, stringValue]) => ({ key, value: { stringValue } }))] }
    const variants = [
      { type: "event", payload: { name: "session_start", attributes: spoofed } },
      { type: "event", payload: { name: "business.result", attributes: spoofed } },
      { type: "measurement", payload: { type: "web-vitals", values: { lcp: 10 } } },
      { type: "exception", payload: { type: "Error", value: "SECRET" } },
      { type: "trace", payload: { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] } },
    ]
    for (const variant of variants) {
      const item = { ...variant, meta } as unknown as TransportItem
      const clean = sanitizeItem(item, session, origin, identity)!
      expect(clean.meta.app?.version).toBe("0.1.44")
      expect(clean.meta.session?.attributes).toEqual({ isSampled: "true", ...identity })
      expect(JSON.stringify(clean)).not.toContain("SECRET")
      expect(JSON.stringify(clean)).not.toContain("9.9.9")
      if (variant.type === "event") expect(clean.payload).toMatchObject({ attributes: identity })
      expect(sanitizeItem(item, "retired-session", origin, identity)).toBeNull()
    }
    const trace = sanitizeTrace(variants[4]!.payload, session, origin, identity)!
    expect(trace.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.version", value: { stringValue: "0.1.44" } })
    for (const [key, stringValue] of Object.entries(identity)) {
      expect(trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes).toContainEqual({ key, value: { stringValue } })
    }
    const invalid = sanitizeTrace(variants[4]!.payload, session, origin, { app_version: "SECRET" })!
    expect(invalid.resourceSpans[0]!.resource.attributes.some(attribute => attribute.key === "service.version")).toBe(false)
  })

  it.each([undefined, "SECRET"])("does not manufacture a missing canonical frontend version from payload or SDK metadata (%s)", version => {
    const identity = resolveFrontendIdentity("web", true, false, version)
    const attributes = { app_version: "9.9.9", frontend_surface: "web", client_platform: "browser" }
    const item = { type: "event", meta: { ...meta, app: { version: "9.9.9" } }, payload: { name: "business.result", attributes } } as TransportItem
    const clean = sanitizeItem(item, session, origin, identity)!
    expect(clean.meta.app?.version).toBeUndefined()
    expect(clean.meta.session?.attributes).not.toHaveProperty("app_version")
    expect(clean.payload).toMatchObject({ attributes: { frontend_surface: "webview", client_platform: "desktop" } })
    expect(JSON.stringify(clean)).not.toContain("9.9.9")
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "dm.message.send", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", attributes: [{ key: "session.id", value: { stringValue: session } }, ...Object.entries(attributes).map(([key, stringValue]) => ({ key, value: { stringValue } }))] }
    const trace = sanitizeTrace({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }, session, origin, identity)!
    expect(JSON.stringify(trace)).not.toContain("9.9.9")
    expect(trace.resourceSpans[0]!.resource.attributes.some(attribute => attribute.key === "service.version")).toBe(false)
    expect(trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes).toContainEqual({ key: "frontend_surface", value: { stringValue: "webview" } })
  })

})
