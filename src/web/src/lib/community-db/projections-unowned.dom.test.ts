import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { configureTelemetry, retireTelemetry } from "@/lib/observability/telemetry"

vi.mock("@tanstack/react-db", async importOriginal => {
  const real = await importOriginal<typeof import("@tanstack/react-db")>()
  return { ...real, useLiveQuery: () => ({ isReady: true, data: [{ id: "server-a", name: "Unowned snapshot", detailComplete: true, ownerId: "viewer" }] }) }
})
it("does not attribute an upstream cached tree snapshot to an absent community owner", async () => {
  const { useServerTreeProjection } = await import("./projections")
  configureTelemetry({ session_id: "snapshot-session" }, true)
  try {
    const client = new QueryClient()
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
    const rendered = renderHook(() => useServerTreeProjection("server-a"), { wrapper })
    expect(rendered.result.current).toBeUndefined()
    rendered.unmount()
  } finally { retireTelemetry() }
})
