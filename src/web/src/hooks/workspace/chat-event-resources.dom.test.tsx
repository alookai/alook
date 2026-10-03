import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import { act, render, waitFor, screen, fireEvent } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { EmailEventSheet } from "@/components/agent-chat/email-event-sheet"
import { CalendarEventSheet } from "@/components/calendar/calendar-event-sheet"
import { EmailCard } from "@/components/agent-chat/event-cards/email-card"
import { useSlashCommand } from "@/hooks/use-slash-command"
import type { Agent, SkillEntry } from "@alook/shared"

const error = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "event-user" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("sonner", () => ({ toast: { error } }))
vi.mock("@/components/ui/markdown-editor", () => ({ MarkdownEditor: () => null }))
let owner: WorkspaceOwner
let requests: Array<{ path: string; resolve: (response: Response) => void }>
const changed = vi.fn()
function Probe({ children }: { children: React.ReactNode }) { const current = useWorkspaceOwner(); useLayoutEffect(() => { owner = current }); return children }
function App({ children }: { children: React.ReactNode }) { return <ApplicationQueryProvider userId="event-user"><WorkspaceProvider workspaceId="workspace" slug="workspace"><Probe>{children}</Probe></WorkspaceProvider></ApplicationQueryProvider> }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const email = (id: string) => ({ id, subject: `Subject ${id}`, from_email: "from@example.test", to_email: "to@example.test", created_at: "2026-10-01T00:00:00Z", attachments: [] })
const calendar = (id: string) => ({ id, title: `Event ${id}`, agent_id: "agent", scheduled_at: "2026-10-03T09:00:00Z", description: "description", repeat_interval: null, repeat_stop_at: null })
function navigationSpy() { const real = window, assign = vi.fn(); vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } })); return assign }
beforeEach(async () => { await clearAllPersistedCaches(); owner = undefined as unknown as WorkspaceOwner; requests = []; changed.mockClear(); error.mockClear(); vi.stubGlobal("fetch", vi.fn((path: string) => new Promise<Response>((resolve) => requests.push({ path, resolve })))) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})

describe("native chat event resources", () => {
  it("retired email metadata and body 401 cannot navigate or close B", async () => {
    const mounted = render(<App><EmailEventSheet open emailId="A" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(requests).toHaveLength(2))
    const assign = navigationSpy()
    act(() => mounted.rerender(<App><EmailEventSheet open emailId="B" workspaceId="workspace" onOpenChange={changed} /></App>))
    await waitFor(() => expect(requests).toHaveLength(4))
    await act(async () => { requests[0].resolve(reply({}, 401)); requests[1].resolve(reply({}, 401)); requests[2].resolve(reply(email("B"))); requests[3].resolve(new Response("body B")) })
    await waitFor(() => expect(screen.getByText("Subject B")).toBeTruthy())
    expect(screen.getByText("body B")).toBeTruthy()
    expect(assign).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
    expect(owner.queryClient.getQueryData(owner.key("emails", "detail", "A"))).toBeUndefined()
    expect(owner.queryClient.getQueryData(owner.key("emails", "body", "B"))).toEqual({ content: "body B", isHtml: false })
  })
  it("closed email drops held responses and native cancellation stays silent", async () => {
    const mounted = render(<App><EmailEventSheet open emailId="A" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(requests).toHaveLength(2))
    const assign = navigationSpy()
    act(() => mounted.rerender(<App><EmailEventSheet open={false} emailId="A" workspaceId="workspace" onOpenChange={changed} /></App>))
    await act(async () => { requests[0].resolve(reply({}, 401)); requests[1].resolve(reply({}, 401)) })
    expect(assign).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  })
  it("qualified native warm email facts paint while the refresh is held", async () => {
    const mounted = render(<App><EmailEventSheet open={false} emailId="warm" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(owner?.workspaceId).toBe("workspace"))
    act(() => { owner.queryClient.setQueryData(owner.key("emails", "detail", "warm"), email("warm"), { updatedAt: 1 }); owner.queryClient.setQueryData(owner.key("emails", "body", "warm"), { content: "warm body", isHtml: false }, { updatedAt: 1 }); mounted.rerender(<App><EmailEventSheet open emailId="warm" workspaceId="workspace" onOpenChange={changed} /></App>) })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(screen.getByText("Subject warm")).toBeTruthy(); expect(screen.getByText("warm body")).toBeTruthy()
  })
  it("current body 401 still performs the authenticated navigation", async () => {
    render(<App><EmailEventSheet open emailId="A" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(requests).toHaveLength(2))
    const assign = navigationSpy()
    await act(async () => { requests[0].resolve(reply(email("A"))); requests[1].resolve(reply({}, 401)) })
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
  })
  it("retired calendar 401 leaves the selected B event visible", async () => {
    const mounted = render(<App><CalendarEventSheet open readonly calendarEventId="A" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(requests).toHaveLength(1))
    const assign = navigationSpy()
    act(() => mounted.rerender(<App><CalendarEventSheet open readonly calendarEventId="B" workspaceId="workspace" onOpenChange={changed} /></App>))
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => { requests[0].resolve(reply({}, 401)); requests[1].resolve(reply(calendar("B"))) })
    await waitFor(() => expect(screen.getByRole("heading", { name: "Event B" })).toBeTruthy())
    expect(assign).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
    expect(owner.queryClient.getQueryData(owner.key("calendar", "detail", "A"))).toBeUndefined()
  })
  it("two email consumers share one held read when only the initiating sheet closes", async () => {
    const another = vi.fn();
    const contents = (first: boolean, second: boolean) => <App><EmailEventSheet open={first} emailId="shared" workspaceId="workspace" onOpenChange={changed} /><EmailEventSheet open={second} emailId="shared" workspaceId="workspace" onOpenChange={another} /></App>;
    const mounted = render(contents(true, true));
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => mounted.rerender(contents(false, true)));
    await act(async () => { requests[0].resolve(reply(email("shared"))); requests[1].resolve(new Response("shared body")); });
    await waitFor(() => expect(screen.getByText("shared body")).toBeTruthy());
    expect(requests).toHaveLength(2); expect(another).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(owner.queryClient.getQueryState(owner.key("emails", "detail", "shared"))?.status).toBe("success");
  });
  it("releasing both shared email consumers cancels the native read before late 401", async () => {
    const contents = (open: boolean) => <App><EmailEventSheet open={open} emailId="shared" workspaceId="workspace" onOpenChange={changed} /><EmailEventSheet open={open} emailId="shared" workspaceId="workspace" onOpenChange={changed} /></App>;
    const mounted = render(contents(true));
    await waitFor(() => expect(requests).toHaveLength(2)); const assign = navigationSpy();
    act(() => mounted.rerender(contents(false)));
    await act(async () => { requests[0].resolve(reply({}, 401)); requests[1].resolve(reply({}, 401)); });
    expect(assign).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(owner.queryClient.getQueryData(owner.key("emails", "detail", "shared"))).toBeUndefined();
  });
  it("current ordinary email failure uses production retry and closes the sheet", async () => {
    render(<App><EmailEventSheet open emailId="A" workspaceId="workspace" onOpenChange={changed} /></App>)
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => { requests[0].resolve(reply({}, 500)); requests[1].resolve(new Response("body")) })
    await waitFor(() => expect(requests).toHaveLength(3), { timeout: 3000 })
    expect(changed).not.toHaveBeenCalled()
    await act(async () => requests[2].resolve(reply({}, 500)))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(false))
    expect(error).toHaveBeenCalledWith("Email not found")
  })
})

describe("UI resource identities", () => {
  it("email hover resolves the latest canonical agent props after a rename", () => {
    const agent = { id: "agent", name: "old name", email_handle: "internal", avatar_url: null } as Agent
    const props = { subject: "subject", address: "address", direction: "inbound" as const, isInternal: true, internalHandle: "internal", targetConvId: "conv", agents: [agent], onClick: vi.fn() }
    const mounted = render(<EmailCard {...props} />)
    act(() => fireEvent.pointerEnter(screen.getByRole("button")))
    expect(screen.getByText("old name")).toBeTruthy()
    act(() => mounted.rerender(<EmailCard {...props} agents={[{ ...agent, name: "new name" }]} />))
    expect(screen.queryByText("old name")).toBeNull(); expect(screen.getByText("new name")).toBeTruthy()
  })
  it("selected skill is a name and follows canonical refresh/removal", () => {
    let active: SkillEntry | null = null
    const original = { name: "deploy", description: "old" } as SkillEntry
    function Skills({ skills }: { skills: SkillEntry[] }) { const popup = useSlashCommand({ input: "", caretIndex: null, skills, initialActiveSkill: original, onInputChange: vi.fn(), getAnchorPos: () => null }); useLayoutEffect(() => { active = popup.activeSkill }); return null }
    const mounted = render(<Skills skills={[]} />)
    expect(active).toBeNull()
    act(() => mounted.rerender(<Skills skills={[original]} />)); expect(active).toBe(original)
    const refreshed = { ...original, description: "new" }
    act(() => mounted.rerender(<Skills skills={[refreshed]} />)); expect(active).toBe(refreshed)
    act(() => mounted.rerender(<Skills skills={[]} />)); expect(active).toBeNull()
  })
})
