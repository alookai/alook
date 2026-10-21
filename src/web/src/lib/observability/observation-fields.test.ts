import type { TransportItem } from "@grafana/faro-web-sdk"
import { expect, it } from "vitest"
import { cleanAttributes } from "./schema"
import { sanitizeItem } from "./sanitize"

it("preserves qualified observation, wait and native entry fields through the actual sanitizer", () => {
  const attributes = {
    navigation_kind: "document_observation", start_ms: 7_200_000, duration_ms: 166, document_elapsed_ms: 7_200_166, document_load_ms: 8625,
    bootstrap_ms: 100, identity_ms: 7_200_000, activation_ms: 7_200_000, sdk_ready_ms: 7_201_000, activation_reason: "identity", document_ready_state: "complete",
    release_reason: "condition_changed", wait_reason: "virtual_window", attribution_source: "script_entry", stack_status: "unavailable", source_status: "available",
    script_source: "/_next/static/chunks/abc123.js", script_function: "onFrame", source_char_position: 42, execution_start_ms: 7_201_100, forced_layout_ms: 60, invoker_type: "user-callback", frame_id: "frame-safe",
  }
  for (const name of ["document.observed", "observation.lifecycle", "main_thread.script", "main_thread.long_animation_frame"]) {
    const item = { type: "event", meta: { sdk: { name: "faro-web", version: "2.12.1" }, session: { id: "session-safe" }, page: { url: "https://alook.ai/c/me/machines" } }, payload: { name, timestamp: "2026-10-20T00:00:00Z", attributes } } as unknown as TransportItem
    expect(sanitizeItem(item, "session-safe", "https://alook.ai")?.payload).toMatchObject({ name, attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)])) })
    expect(sanitizeItem(item, "retired-session", "https://alook.ai")).toBeNull()
  }
})

it("drops arbitrary invoker text, stacks, private sources and invalid native timings", () => {
  const fields = cleanAttributes({ invoker: "PRIVATE", stack: "PRIVATE", script_source: "https://private.example/PRIVATE.js?token=PRIVATE", script_function: "private message PRIVATE", source_char_position: -1, duration_ms: Infinity, document_load_ms: NaN, activation_reason: "PRIVATE", release_reason: "PRIVATE" })
  expect(fields).toEqual({})
  expect(cleanAttributes({ script_source: "/_next/static/chunks/x.js?token=PRIVATE" })).toEqual({})
})
