import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, waitFor, screen, fireEvent } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import CalendarPage from "@/app/(app)/w/[slug]/calendar/page"
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
const search = new URLSearchParams("y=2026&m=9")
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => search, usePathname: () => "/w/workspace/calendar" }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "calendar-user" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
const agents = [{ id: "agent", name: "Agent", avatar_url: null }]
const subscribeWs = () => () => {}
vi.mock("@/contexts/agent-context", () => ({ useAgentContext: () => ({ agents, subscribeWs }) }))
vi.mock("@/components/ui/markdown-editor", () => ({ MarkdownEditor: () => null }))
let owner: WorkspaceOwner
let held: Array<{ path: string; method: string; body?: string; resolve: (response: Response) => void; signal: AbortSignal }>
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
function Probe() { const current = useWorkspaceOwner(); useLayoutEffect(() => { owner = current }); return <CalendarPage /> }
function App() { return <ApplicationQueryProvider userId="calendar-user"><WorkspaceProvider workspaceId="workspace" slug="workspace"><Probe /></WorkspaceProvider></ApplicationQueryProvider> }
beforeEach(async () => { await clearAllPersistedCaches(); vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); held = []; toast.error.mockClear(); toast.success.mockClear(); vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => new Promise<Response>((resolve) => held.push({ path, method: options.method ?? "GET", body: options.body as string | undefined, resolve, signal: options.signal as AbortSignal })))) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})
describe("native calendar page resource ownership", () => {
  it("changing range cancels the old native read before its late 401", async () => {
    render(<App />); await waitFor(() => expect(held).toHaveLength(1)); const real = window, assign = vi.fn(); vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Next month" }))); await waitFor(() => expect(held).toHaveLength(2)); expect(held[0].signal.aborted).toBe(true);
    await act(async () => { held[0].resolve(response({}, 401)); held[1].resolve(response([])) }); await waitFor(() => expect(screen.getByRole("grid", { name: "Calendar November 2026" })).toBeTruthy()); expect(assign).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled()
  })
  it("creates from the actual sheet form and publishes into the native range", async () => {
    render(<App />); await waitFor(() => expect(held).toHaveLength(1)); await act(async () => held[0].resolve(response([])));
    act(() => fireEvent.click(screen.getByRole("button", { name: "New event" }))); await waitFor(() => expect(screen.getByRole("textbox", { name: "Event title" })).toBeTruthy()); act(() => fireEvent.change(screen.getByRole("textbox", { name: "Event title" }), { target: { value: "Created event" } })); act(() => fireEvent.click(screen.getByRole("button", { name: /Create event/ })));
    await waitFor(() => expect(held.some((request) => request.method === "POST")).toBe(true)); const request = held.find((item) => item.method === "POST")!, values = JSON.parse(request.body!); const created = { id: "created", ...values, repeat_interval: null, repeat_stop_at: null, status: "pending" };
    await act(async () => request.resolve(response(created))); await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Event created")); const queries = owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("calendar", "range") }); expect(queries.some((query) => Array.isArray(query.state.data) && query.state.data.some((row) => row.id === "created"))).toBe(true); expect(screen.queryByRole("textbox", { name: "Event title" })).toBeNull()
  })
})
