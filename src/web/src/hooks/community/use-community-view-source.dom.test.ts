import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"
import { useCommunityViewSource } from "./use-community-view-source"

it("keeps real view cleanup cancellation bound to its original telemetry generation", async () => {
  const client = new QueryClient(), registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  const activate = (session: string) => { configureTelemetry({ session_id: session }, true); installTelemetrySink(event => events.push(event)) }
  function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
  activate("original-session")
  const original = renderHook(() => useCommunityViewSource("private-view"), { wrapper: Owner })
  const oldSignal = original.result.current.signal
  retireTelemetry(); activate("replacement-session")
  const count = events.length
  original.unmount()
  expect(oldSignal.aborted).toBe(true)
  expect(oldSignal.reason).toMatchObject({ name: "AbortError" })
  expect(events).toHaveLength(count)
  const replacement = renderHook(() => useCommunityViewSource("private-view"), { wrapper: Owner })
  const signal = replacement.result.current.signal
  act(() => replacement.result.current.retire())
  expect(signal.aborted).toBe(true)
  expect(events.at(-1)!.attributes).toMatchObject({ session_id: "replacement-session", abort_cause: "view_retire", abort_phase: "abort" })
  expect(JSON.stringify(events)).not.toContain("private")
  replacement.unmount(); retireTelemetry()
  await act(async () => { await registry.cleanup(); client.clear() })
})
