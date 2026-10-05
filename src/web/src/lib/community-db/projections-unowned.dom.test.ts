import { expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { configureTelemetry, retireTelemetry } from "@/lib/observability/telemetry"
import { viewEvidence } from "@/lib/observability/data-source"

vi.mock("@tanstack/react-db", async importOriginal => {
  const real = await importOriginal<typeof import("@tanstack/react-db")>()
  return { ...real, useLiveQuery: () => ({ data: [{ id: "server-a", name: "Unowned snapshot", detailComplete: true, ownerId: "viewer" }] }) }
})
it("does not attribute an upstream cached tree snapshot to an absent community owner", async () => {
  const { useServerTreeProjection } = await import("./projections")
  configureTelemetry({ session_id: "snapshot-session" }, true)
  try {
    const rendered = renderHook(() => useServerTreeProjection("server-a"))
    expect(rendered.result.current).toMatchObject({ id: "server-a", name: "Unowned snapshot", categories: [] })
    expect(viewEvidence(rendered.result.current).source).toBe("unknown")
    rendered.unmount()
  } finally { retireTelemetry() }
})
