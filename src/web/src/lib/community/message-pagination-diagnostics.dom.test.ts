import { StrictMode, createElement, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { installMessagePaginationDiagnostics } from "@/test/e2e-ui/_fixtures/message-pagination-diagnostics"
import { paginationDiagnostic, paginationDiagnosticId, usePaginationDiagnosticSource } from "./message-pagination-diagnostics"

afterEach(() => { delete window.__alookPaginationDiagnostics })
function installObserver() {
  installMessagePaginationDiagnostics()
  return window.__alookPaginationDiagnostics!
}

describe("temporary message pagination diagnostic observer", () => {
  it("is dormant without an installed observer", () => {
    const read = vi.fn(() => ({ scope: "c1" }))
    function Probe() { usePaginationDiagnosticSource("owner", read); return null }
    const view = render(createElement(Probe))
    paginationDiagnostic("c1", "event", read)
    expect(read).not.toHaveBeenCalled()
    expect(paginationDiagnosticId({})).toBeNull()
    view.unmount()
  })

  it("reads committed owners in one synchronous clock interval and retires them on unmount", () => {
    const observer = installObserver()
    function Probe() {
      const [value, setValue] = useState(0)
      usePaginationDiagnosticSource("owner", () => ({ scope: "c1", value }))
      return createElement("button", { onClick: () => setValue(value + 1) }, String(value))
    }
    const view = render(createElement(StrictMode, null, createElement(Probe)))
    expect(observer.sources.size).toBe(1)
    fireEvent.click(view.getByRole("button", { name: "0" }))
    observer.checkpoint("c1", "after-real-input")
    const records = observer.packet().records as Array<{ startedAt: number; endedAt: number; readers: unknown[] }>
    expect(records.at(-1)?.readers).toEqual([{ source: "owner", scope: "c1", value: 1 }])
    expect(records.at(-1)!.endedAt).toBeGreaterThanOrEqual(records.at(-1)!.startedAt)
    view.unmount()
    expect(observer.sources.size).toBe(0)
    observer.capture("c1", "retired")
    expect(records.at(-1)?.readers).toEqual([])
  })

  it("keeps scope readers separate and reports a missing reader without serializing its exception", () => {
    const observer = installObserver()
    observer.sources.add({ name: "narrow", read: () => ({ scope: "narrow", value: 1 }) })
    observer.sources.add({ name: "desktop", read: () => ({ scope: "desktop", value: 2 }) })
    observer.sources.add({ name: "missing", read: () => { throw new Error("private exception detail") } })
    observer.capture("narrow", "checkpoint")
    expect(observer.packet().records).toEqual([expect.objectContaining({ readers: [
      { source: "narrow", scope: "narrow", value: 1 }, { source: "missing", readError: true },
    ] })])
    expect(observer.packet().sourceReadErrors).toBe(1)
    expect(JSON.stringify(observer.packet())).not.toContain("private exception detail")
  })

  it("bounds retained records while retaining the first refusal and full invocation count", () => {
    const observer = installObserver()
    for (let index = 0; index < 2050; index++) observer.capture("c1", "end.load.rejected", { reason: "no-neighbor" })
    expect(observer.packet().records).toHaveLength(1024)
    expect(observer.packet().dropped).toBe(1026)
    expect(observer.packet().firstRejections).toEqual([expect.objectContaining({ sequence: 1 })])
    expect(observer.packet().counts).toEqual({ "c1:setup:end.load.rejected": 2050 })
  })

  it("keeps the real admitted loader unchanged when capture or identity observation throws", () => {
    const observer = installObserver()
    observer.capture = () => { throw new Error("observer-only") }
    observer.id = () => { throw new Error("identity-only") }
    const load = vi.fn(() => ({ accepted: false as const }))
    const requestKey = {}
    const virtualizer = { getVirtualItems: () => [{ key: "m1", index: 0, start: 0, end: 100, size: 100, lane: 0 }] }
    function Probe() {
      useVirtualCursorPagination({ diagnosticScope: "c1", virtualizer, edge: "end", count: 1,
        hasMore: true, loadWhenReady: true, requestKey, onLoad: load })
      return null
    }
    const view = render(createElement(Probe))
    expect(load).toHaveBeenCalledOnce()
    expect(() => paginationDiagnostic("c1", "manual", () => { throw new Error("detail-only") })).not.toThrow()
    expect(paginationDiagnosticId(requestKey)).toBeNull()
    expect(observer.observerFailures).toBeGreaterThanOrEqual(3)
    view.unmount()
    expect(observer.sources.size).toBe(0)
  })
})
