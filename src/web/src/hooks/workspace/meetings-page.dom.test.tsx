import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import AgentMeetingsPage from "@/app/(app)/w/[slug]/agents/[id]/meetings/page"
import type { MeetingSession } from "@alook/shared"
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "agent" }), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "meeting-user" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
let owner: WorkspaceOwner
let held: Array<{ path: string; method: string; body?: string; resolve: (response: Response) => void; signal?: AbortSignal }>
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const meeting = (id = "meeting", status = "pending"): MeetingSession => ({ id, agent_id: "agent", workspace_id: "workspace", title: `Meeting ${id}`, meeting_url: "https://meet.google.com/abc", status, from_email: null, is_whitelisted: false, participants: [], scheduled_at: null, started_at: null, completed_at: null, transcript_r2_key: null, summary: null, error: null, worker_session_id: null, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z" })
function Probe({ show }: { show: boolean }) { const current = useWorkspaceOwner(); useLayoutEffect(() => { owner = current }); return show ? <AgentMeetingsPage /> : <p>Another view</p> }
function App({ show = true }: { show?: boolean }) { return <ApplicationQueryProvider userId="meeting-user"><WorkspaceProvider workspaceId="workspace" slug="workspace"><Probe show={show} /></WorkspaceProvider></ApplicationQueryProvider> }
beforeEach(async () => { await clearAllPersistedCaches(); held = []; toast.error.mockClear(); toast.success.mockClear(); vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => new Promise<Response>((resolve) => held.push({ path, method: options.method ?? "GET", body: options.body as string | undefined, resolve, signal: options.signal ?? undefined })))) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})
async function loaded(rows: MeetingSession[] = []) {
  const view = render(<App />)
  await waitFor(() => expect(held).toHaveLength(1))
  await act(async () => held[0].resolve(response(rows)))
  await waitFor(() => expect(owner.queryClient.getQueryData(owner.key("meetings", "agent"))).toEqual(rows))
  return view
}
async function createRequest() {
  act(() => fireEvent.click(screen.getByRole("button", { name: "Join Meeting" })))
  const dialog = await screen.findByRole("dialog")
  act(() => fireEvent.change(within(dialog).getByPlaceholderText("https://meet.google.com/abc-defg-hij"), { target: { value: "https://meet.google.com/new" } }))
  act(() => fireEvent.click(within(dialog).getByRole("button", { name: "Join Meeting" })))
  await waitFor(() => expect(held.some((request) => request.method === "POST")).toBe(true))
  return held.find((request) => request.method === "POST")!
}
describe("actual native meetings page", () => {
  it("creates through the real sheet and publishes one canonical list", async () => {
    await loaded()
    const request = await createRequest()
    expect(JSON.parse(request.body!)).toEqual({ meetingUrl: "https://meet.google.com/new" })
    await act(async () => request.resolve(response(meeting("created"))))
    await waitFor(() => expect(screen.getByText("Meeting created")).toBeTruthy())
    expect(owner.queryClient.getQueryData<MeetingSession[]>(owner.key("meetings", "agent"))?.map((row) => row.id)).toEqual(["created"])
    expect(toast.success).toHaveBeenCalledWith("Meeting created")
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("settles a successful old-view create in its original native Query without old UI continuation", async () => {
    const view = await loaded()
    const request = await createRequest()
    const original = owner.queryClient.getQueryCache().find({ queryKey: owner.key("meetings", "agent"), exact: true })!
    view.rerender(<App show={false} />)
    await act(async () => request.resolve(response(meeting("old-success"))))
    await waitFor(() => expect((original.state.data as MeetingSession[]).map((row) => row.id)).toEqual(["old-success"]))
    expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled()
    expect(held).toHaveLength(2)
  })
  it("does not resurrect a cleared Query after successful old create", async () => {
    const view = await loaded()
    const request = await createRequest()
    view.rerender(<App show={false} />)
    owner.queryClient.removeQueries({ queryKey: owner.key("meetings", "agent"), exact: true })
    await act(async () => request.resolve(response(meeting("old-cleared"))))
    expect(owner.queryClient.getQueryData(owner.key("meetings", "agent"))).toBeUndefined()
    expect(toast.success).not.toHaveBeenCalled()
  })
  it("keeps retired create401 quiet before global authentication effects", async () => {
    const view = await loaded()
    const request = await createRequest()
    const real = window, assign = vi.fn()
    vi.stubGlobal("window", new Proxy(real, { get: (target, key) => key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) }))
    view.rerender(<App show={false} />)
    await act(async () => request.resolve(response({}, 401)))
    await waitFor(() => expect(owner.queryClient.isMutating()).toBe(0))
    expect(assign).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled()
    expect(owner.application.lifecycle.get().active).toBe(true)
  })
  it("deletes through the real confirmation and retains ordinary current errors", async () => {
    await loaded([meeting()])
    act(() => fireEvent.click(screen.getByRole("button", { name: "Delete Meeting meeting" })))
    const dialog = await screen.findByRole("dialog")
    act(() => fireEvent.click(within(dialog).getByRole("button", { name: "Remove" })))
    await waitFor(() => expect(held.some((request) => request.method === "DELETE")).toBe(true))
    await act(async () => held.find((request) => request.method === "DELETE")!.resolve(response({ error: "failed" }, 500)))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to delete meeting"))
    expect(owner.queryClient.getQueryData<MeetingSession[]>(owner.key("meetings", "agent"))).toHaveLength(1)
  })
  it("last page observer release aborts a held read before a late401", async () => {
    const view = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    view.rerender(<App show={false} />)
    expect(held[0].signal?.aborted).toBe(true)
    const real = window, assign = vi.fn()
    vi.stubGlobal("window", new Proxy(real, { get: (target, key) => key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) }))
    await act(async () => held[0].resolve(response({}, 401)))
    expect(assign).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled()
  })
})
