import type { Faro } from "@grafana/faro-web-sdk"
import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const native = vi.hoisted(() => ({ faro: undefined as Faro | undefined, release: undefined as (() => void) | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  await new Promise<void>(resolve => { native.release = resolve })
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => { native.faro = real.initializeFaro(...args); return native.faro } }
})
afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  Reflect.deleteProperty(window, "__TAURI__")
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
it("delivers safe image correlations through real Faro and preserves consent, early queue and WebView build boundaries", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "b".repeat(40))
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: { core: {} } })
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  const sent: Array<{ meta: { app: Record<string, unknown> }; events?: Array<{ name: string; attributes: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }) }))
  const { bootstrapObservability } = await import("./client")
  const { observeImage } = await import("./images")
  const { isTelemetryEligible, emitTelemetry } = await import("./telemetry")
  const consent = (decision: "granted" | "denied") => { document.cookie = `alook_analytics_consent=v1.${decision}; path=/`; announceAnalyticsConsent(decision) }
  const node = document.createElement("img")
  node.src = "/api/community/users/private/avatar?v=2&token=private"
  consent("denied"); bootstrapObservability("web")
  observeImage(node, "identity", "error", node)
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(0)
  await act(async () => { consent("granted"); await Promise.resolve() })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  observeImage(node, "identity", "decode_error", node)
  for (let i = 0; i < 300; i++) emitTelemetry("image.lifecycle", { image_phase: "decode_error", attempt: i })
  consent("denied"); consent("granted")
  native.release?.()
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
  expect(isTelemetryEligible()).toBe(true)
  const session = native.faro!.api.getSession()!.id!
  observeImage(node, "identity", "load", node, { attempt: 2, image_generation: 3, current_node: true })
  native.faro!.api.pushEvent("image.lifecycle", { session_id: session, image_slot: "identity", image_phase: "decode_ready", image_node_id: "safe-node", raw_url: node.src, alt: "private body", Cookie: "private credential" }, "alook.frontend", { skipDedupe: true })
  await vi.advanceTimersByTimeAsync(1500)
  const events = sent.flatMap(body => body.events ?? [])
  expect(events.some(event => event.name === "image.lifecycle" && event.attributes.image_phase === "decode_error")).toBe(false)
  const load = events.find(event => event.name === "image.lifecycle" && event.attributes.image_phase === "load")!
  expect(load.attributes).toMatchObject({ session_id: session, attempt: "2", image_generation: "3", current_node: "true", frontend_surface: "webview", runtime_platform: "desktop", native_build_binding: "unavailable", environment: "qa", release: "b".repeat(40) })
  expect(load.attributes.page_instance_id).toBeTruthy()
  expect(load.attributes.image_node_id).toBeTruthy()
  expect(load.attributes.image_source_id).toBeTruthy()
  expect(events.some(event => event.name === "image.lifecycle" && event.attributes.image_node_id === "safe-node")).toBe(true)
  expect(JSON.stringify(sent)).not.toContain("private")
  for (const body of sent) expect(body.meta.app).toMatchObject({ environment: "qa", release: "b".repeat(40) })
  consent("denied")
  const count = sent.length
  native.faro!.api.pushEvent("image.lifecycle", { session_id: session, image_phase: "error" }, "alook.frontend", { skipDedupe: true })
  emitTelemetry("image.lifecycle", { image_phase: "timeout" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(sent).toHaveLength(count)
})
