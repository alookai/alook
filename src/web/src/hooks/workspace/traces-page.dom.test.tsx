import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, mockElementGeometry } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import TracesPage from "@/app/(app)/w/[slug]/traces/page"
import TraceDetailPage from "@/app/(app)/w/[slug]/traces/[traceId]/page"
const state = vi.hoisted(() => ({ search: new URLSearchParams("status=active"), traceId: "trace-A", analytics: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackThreadViewed: state.analytics }))
vi.mock("next/navigation", () => ({ useParams: () => ({ traceId: state.traceId }), useSearchParams: () => state.search, useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "traces-user" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("@/contexts/agent-context", () => ({ useAgentContext: () => ({ agents: [] }) }))
vi.mock("@/contexts/channel-context", () => ({ useChannel: () => ({ channels: [] }) }))
let owner: WorkspaceOwner
let held: Array<{ path: string; resolve: (response: Response) => void; signal: AbortSignal }>
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const trace = (id: string, started_at: string) => ({ trace_id: id, root_prompt: `Prompt ${id}`, root_agent_id: "agent", root_agent: null, helper_agents: [], status: "active", task_count: 2, started_at, completed_at: null, channel: "general" })
const task = (id: string) => ({ id, agent_id: "agent", agent: null, parent_task_id: null, prompt: `Task ${id}`, status: "completed", type: "chat", conversation_id: "conversation", created_at: "2026-10-01T01:00:00Z", completed_at: "2026-10-01T01:01:00Z" })
function Probe({ detail, show }: { detail: boolean; show: boolean }) { const current = useWorkspaceOwner(); useLayoutEffect(() => { owner = current }); return show ? detail ? <TraceDetailPage /> : <TracesPage /> : <p>Other page</p> }
function App({ detail = false, show = true }: { detail?: boolean; show?: boolean }) { return <ApplicationQueryProvider userId="traces-user"><WorkspaceProvider workspaceId="workspace" slug="workspace"><Probe detail={detail} show={show} /></WorkspaceProvider></ApplicationQueryProvider> }
beforeEach(async () => { await clearAllPersistedCaches(); state.search = new URLSearchParams("status=active"); state.traceId = "trace-A"; state.analytics.mockClear(); held = []; vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => new Promise<Response>((resolve) => held.push({ path, resolve, signal: options.signal as AbortSignal })))) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})
describe("actual native trace pages", () => {
  it("paginates one InfiniteQuery, deduplicates rows and preserves page params", async () => {
    render(<App />); await waitFor(() => expect(held).toHaveLength(1))
    expect(new URL(held[0].path, "https://alook.test").searchParams.get("multiAgent")).toBe("true")
    await act(async () => held[0].resolve(response({ traces: [trace("new", "2026-10-02T00:00:00Z")], has_more: true })))
    const link = await screen.findByRole("link", { name: /Prompt new/ }); const scroll = link.parentElement!.parentElement!
    const restore = mockElementGeometry(scroll, { scrollHeight: 600, clientHeight: 500, scrollTop: 10 })
    act(() => { fireEvent.scroll(scroll); fireEvent.scroll(scroll) })
    await waitFor(() => expect(held).toHaveLength(2))
    expect(new URL(held[1].path, "https://alook.test").searchParams.get("before")).toBe("2026-10-02T00:00:00Z")
    await act(async () => held[1].resolve(response({ traces: [trace("new", "2026-10-02T00:00:00Z"), trace("old", "2026-10-01T00:00:00Z")], has_more: false })))
    await waitFor(() => expect(screen.getByRole("link", { name: /Prompt old/ })).toBeTruthy())
    expect(screen.getAllByRole("link", { name: /Prompt new/ })).toHaveLength(1)
    const query = owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("traces", "list") })[0]
    expect(query.state.data).toMatchObject({ pageParams: [null, "2026-10-02T00:00:00Z"], pages: [{ has_more: true }, { has_more: false }] }); restore()
  })
  it("filter replacement cancels the old native read before old401", async () => {
    const view = render(<App />); await waitFor(() => expect(held).toHaveLength(1))
    state.search = new URLSearchParams("status=completed"); view.rerender(<App />)
    await waitFor(() => expect(held).toHaveLength(2)); expect(held[0].signal.aborted).toBe(true)
    const real = window, assign = vi.fn(); vi.stubGlobal("window", new Proxy(real, { get: (target, key) => key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) }))
    await act(async () => { held[0].resolve(response({}, 401)); held[1].resolve(response({ traces: [trace("current", "2026-10-02T00:00:00Z")], has_more: false })) })
    await screen.findByRole("link", { name: /Prompt current/ }); expect(assign).not.toHaveBeenCalled()
  })
  it("trace detail shares the canonical resource and ignores old selection analytics", async () => {
    const view = render(<App detail />); await waitFor(() => expect(held).toHaveLength(1))
    state.traceId = "trace-B"; view.rerender(<App detail />)
    await waitFor(() => expect(held).toHaveLength(2)); expect(held[0].signal.aborted).toBe(true)
    await act(async () => { held[0].resolve(response({ trace_id: "trace-A", channel: "old", tasks: [task("old")] })); held[1].resolve(response({ trace_id: "trace-B", channel: "current", tasks: [task("current")] })) })
    await screen.findByRole("link", { name: /Task current/ })
    expect(screen.queryByText("Task old")).toBeNull(); expect(state.analytics).toHaveBeenCalledTimes(1)
    expect(owner.queryClient.getQueryData(owner.key("traces", "detail", "trace-B"))).toMatchObject({ channel: "current", tasks: [{ id: "current" }] })
  })
})
