import { afterEach, describe, expect, it } from "vitest"
import { QueryClient, QueryObserver, dehydrate, skipToken } from "@tanstack/react-query"
import { captureQueryReceipt, withQueryReceipt, reconcileQueryReceipt } from "./query-receipt"

const clients: QueryClient[] = []
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, structuralSharing: reconcileQueryReceipt } } })
  clients.push(qc)
  return qc
}
afterEach(() => { for (const qc of clients.splice(0)) qc.clear() })

describe("native Query final publication", () => {
  it.each(["changed", "equal", "aba"])("preserves a newer %s write after a held HTTP response", async (mode) => {
    const qc = client(), key = ["entity"]
    qc.setQueryData(key, { title: "before" })
    let finish!: (value: { title: string }) => void
    const response = new Promise<{ title: string }>((resolve) => { finish = resolve })
    const pending = qc.fetchQuery({ queryKey: key, queryFn: async () => {
      const receipt = captureQueryReceipt(qc, key)
      return withQueryReceipt(await response, receipt)
    } })
    qc.setQueryData(key, { title: "live" })
    if (mode === "equal") qc.setQueryData(key, { title: "live" })
    if (mode === "aba") qc.setQueryData(key, { title: "before" })
    finish({ title: "stale HTTP" })
    await pending
    expect(qc.getQueryData(key)).toEqual({ title: mode === "aba" ? "before" : "live" })
  })

  it("publishes current HTTP data and strips its publication metadata", async () => {
    const qc = client(), key = ["current"]
    await qc.fetchQuery({ queryKey: key, queryFn: async () => withQueryReceipt({ title: "HTTP" }, captureQueryReceipt(qc, key)) })
    expect(qc.getQueryData(key)).toEqual({ title: "HTTP" })
    expect(Object.getOwnPropertySymbols(qc.getQueryData(key)!)).toHaveLength(0)
    expect(JSON.stringify(dehydrate(qc))).toContain("HTTP")
  })

  it("does not publish into a recreated resource with the same key", () => {
    const qc = client(), key = ["recreated"]
    qc.setQueryData(key, { title: "old" })
    const receipt = captureQueryReceipt(qc, key)
    qc.removeQueries({ queryKey: key, exact: true })
    qc.setQueryData(key, { title: "replacement" })
    qc.setQueryData(key, withQueryReceipt({ title: "late" }, receipt))
    expect(qc.getQueryData(key)).toEqual({ title: "replacement" })
  })

  it("uses the domain merge at the native write boundary after a concurrent addition", async () => {
    const qc = client(), key = ["rows"]
    qc.setQueryData(key, [{ id: "same", value: "before" }])
    let finish!: () => void
    const response = new Promise<void>((resolve) => { finish = resolve })
    const pending = qc.fetchQuery({ queryKey: key, queryFn: async () => {
      const receipt = captureQueryReceipt(qc, key)
      await response
      return withQueryReceipt([{ id: "same", value: "stale" }, { id: "HTTP", value: "new" }], receipt,
        (previous, incoming) => [...new Map([...(incoming as Array<{ id: string }>), ...(previous as Array<{ id: string }>)].map((row) => [row.id, row])).values()])
    } })
    qc.setQueryData(key, [{ id: "same", value: "live" }, { id: "WS", value: "new" }])
    finish(); await pending
    expect(qc.getQueryData(key)).toEqual([{ id: "same", value: "live" }, { id: "HTTP", value: "new" }, { id: "WS", value: "new" }])
  })

  it("retains native defaults when a canonical display observer has no queryFn", () => {
    const qc = client(), key = ["display"]
    qc.setQueryDefaults(key, { structuralSharing: reconcileQueryReceipt })
    qc.setQueryData(key, { title: "old" })
    const receipt = captureQueryReceipt(qc, key)
    const observer = new QueryObserver(qc, { queryKey: key, queryFn: skipToken, enabled: false })
    const release = observer.subscribe(() => undefined)
    qc.setQueryData(key, { title: "live" })
    qc.setQueryData(key, withQueryReceipt({ title: "late" }, receipt))
    expect(observer.getCurrentResult().data).toEqual({ title: "live" })
    release(); observer.destroy()
  })
})
