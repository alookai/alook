import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { ApplicationQueryProvider, useApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { useLocalStorage } from "./use-local-storage"
import { clearAllPersistedCaches } from "@/lib/query-persister"
const identity = vi.hoisted(() => ({ user: "A" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: identity.user } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
let owner: ApplicationOwner
const values: Record<string, [string, (value: string | ((previous: string) => string)) => void]> = {}
const counts: Record<string, number> = {}
function Probe({ name, stateKey = "shared" }: { name: string; stateKey?: string }) { const currentOwner = useApplicationOwner(), value = useLocalStorage(stateKey, "default"); useLayoutEffect(() => { owner = currentOwner; values[name] = value; counts[name] = (counts[name] ?? 0) + 1 }); return null }
function App({ user = "A", children }: { user?: string; children: React.ReactNode }) { return <ApplicationQueryProvider userId={user}>{children}</ApplicationQueryProvider> }
beforeEach(async () => { await clearAllPersistedCaches(); localStorage.clear(); identity.user = "A"; for (const key of Object.keys(values)) delete values[key]; for (const key of Object.keys(counts)) delete counts[key] })
afterEach(() => owner?.queryClient.clear())
describe("original-account native persisted UI", () => {
  it("an inline object default preserves the current draft across renders", () => {
    let value!: ReturnType<typeof useLocalStorage<{ text: string }>>
    function ObjectProbe() { const current = useLocalStorage("object", { text: "default" }); useLayoutEffect(() => { value = current }); return null }
    const mounted = render(<App><ObjectProbe /></App>)
    act(() => value[1]({ text: "edited" }))
    act(() => mounted.rerender(<App><ObjectProbe /></App>))
    expect(value[0]).toEqual({ text: "edited" })
  })
  it("one key has one Store value shared by two consumers and a functional write", async () => {
    render(<App><Probe name="first" /><Probe name="second" /></App>); await waitFor(() => expect(values.second).toBeDefined())
    act(() => values.first[1]((value) => `${value} changed`)); expect(values.first[0]).toBe("default changed"); expect(values.second[0]).toBe("default changed"); expect(localStorage.getItem("alook:A:ui:shared")).toBe(JSON.stringify("default changed"))
  })
  it("a key change gets its own initial value without borrowing the previous key", async () => {
    const mounted = render(<App><Probe name="first" /></App>); await waitFor(() => expect(values.first).toBeDefined()); act(() => values.first[1]("old"));
    act(() => mounted.rerender(<App><Probe name="first" stateKey="next" /></App>)); expect(values.first[0]).toBe("default")
  })
  it("unqualified old device value is ignored and a qualified value hydrates", async () => {
    localStorage.setItem("shared", JSON.stringify("unqualified")); localStorage.setItem("alook:A:ui:shared", JSON.stringify("qualified"));
    render(<App><Probe name="first" /></App>); await waitFor(() => expect(values.first?.[0]).toBe("qualified"))
  })
  it("switching account rejects the old setter and hydrates only B", async () => {
    localStorage.setItem("alook:B:ui:shared", JSON.stringify("B value")); const mounted = render(<App><Probe name="first" /></App>); await waitFor(() => expect(values.first).toBeDefined());
    act(() => values.first[1]("A value")); const oldSet = values.first[1]; identity.user = "B";
    act(() => mounted.rerender(<App user="B"><Probe name="first" /></App>)); await waitFor(() => expect(values.first[0]).toBe("B value")); act(() => oldSet("late A"));
    expect(values.first[0]).toBe("B value"); expect(localStorage.getItem("alook:A:ui:shared")).toBe(JSON.stringify("A value"))
  })
  it("storage updates notify both readers and unrelated keys leave the selected reader stable", async () => {
    render(<App><Probe name="first" /><Probe name="second" /><Probe name="other" stateKey="other" /></App>); await waitFor(() => expect(values.other).toBeDefined()); const before = counts.first;
    act(() => values.other[1]("changed other")); expect(counts.first).toBe(before);
    act(() => { localStorage.setItem("alook:A:ui:shared", JSON.stringify("external")); window.dispatchEvent(new StorageEvent("storage", { key: "alook:A:ui:shared" })) }); expect(values.first[0]).toBe("external"); expect(values.second[0]).toBe("external")
  })
  it("Strict lifecycle replay keeps the current qualified setter usable", async () => {
    render(<React.StrictMode><App><Probe name="first" /></App></React.StrictMode>); await waitFor(() => expect(values.first).toBeDefined()); act(() => values.first[1]("strict current")); expect(values.first[0]).toBe("strict current")
  })
})
