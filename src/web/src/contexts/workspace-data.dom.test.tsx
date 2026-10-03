import "fake-indexeddb/auto"
import { useLayoutEffect } from "react"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "./workspace-context"
import { AgentProvider, useAgentContext } from "./agent-context"
import { ChannelProvider, useChannel } from "./channel-context"
import { InboxCountProvider, useInboxCount } from "./inbox-count-context"
import { FlagCountProvider, useFlagCount } from "./flag-count-context"
import { setInboxFilterTypes } from "@/lib/inbox-filter"
import { focusManager } from "@tanstack/react-query"
import { useMarkAllInboxRead, useUnflagWorkspaceMessage, useWorkspaceFlags, useWorkspaceInbox } from "@/hooks/workspace/use-inbox"
import CreateAgentPage from "@/app/(app)/w/[slug]/agents/new/page"

const mocks = vi.hoisted(() => ({
  userId: "viewer-a",
  ws: null as null | ((message: unknown) => void),
  router: { replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() },
  listAgents: vi.fn(), listRuntimes: vi.fn(), listAgentLinks: vi.fn(), listAgentPins: vi.fn(),
  listAgentActiveTaskCounts: vi.fn(), listWorkspaceActiveTasks: vi.fn(),
  createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), deleteMachine: vi.fn(), createMachineToken: vi.fn(),
  pinAgent: vi.fn(), unpinAgent: vi.fn(), reorderAgentPins: vi.fn(), reorderUnpinnedAgents: vi.fn(),
  listChannels: vi.fn(), createChannelApi: vi.fn(), renameChannelApi: vi.fn(), deleteChannelApi: vi.fn(), reorderChannelsApi: vi.fn(),
  getInboxCount: vi.fn(), getFlaggedCount: vi.fn(), notify: vi.fn(), toast: vi.fn(),
  listInboxItems: vi.fn(), listFlaggedItems: vi.fn(), markAllInboxRead: vi.fn(), unflagMessage: vi.fn(),
  fetchModelOptions: vi.fn(), createEmailAccount: vi.fn(), successToast: vi.fn(), analytics: vi.fn(),
  save: null as null | ((data: { name: string; description: string; instructions: string; runtime_id: string; custom_email?: { emailAddress: string } }) => Promise<boolean>),
}))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ isPending: false, error: null, data: { user: { id: mocks.userId } } }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }))
vi.mock("@/lib/api", () => mocks)
vi.mock("sonner", () => ({ toast: { error: mocks.toast, success: mocks.successToast } }))
vi.mock("@/components/agent-create-form", () => ({ AgentCreateForm: (props: { onSave: typeof mocks.save }) => { mocks.save = props.onSave; return null } }))
vi.mock("@/lib/analytics", () => ({ trackAgentCreated: mocks.analytics, trackSecondAgentCreated: mocks.analytics, trackCustomEmailConnected: mocks.analytics }))
vi.mock("@/lib/browser-notification", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/browser-notification")>(), sendTaskNotification: mocks.notify }))
vi.mock("@/lib/use-user-ws", () => ({ useUserWs: (callback: (message: unknown) => void) => { mocks.ws = callback } }))

function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const pins = () => ({
  pins: ["a", "b"].map((agent_id, position) => ({ id: `pin-${agent_id}`, agent_id, position, created_at: "2026-10-01T00:00:00Z" })),
  sidebar_order: ["c", "d"].map((agent_id, position) => ({ agent_id, position })),
})
let current: {
  workspace: WorkspaceOwner,
  agents: ReturnType<typeof useAgentContext>, channel: ReturnType<typeof useChannel>,
  inbox: ReturnType<typeof useInboxCount>, flags: ReturnType<typeof useFlagCount>,
  inboxPages: ReturnType<typeof useWorkspaceInbox>, flagPages: ReturnType<typeof useWorkspaceFlags>,
  markAll: ReturnType<typeof useMarkAllInboxRead>, unflag: ReturnType<typeof useUnflagWorkspaceMessage>,
}
let listsEnabled = false
let showCreatePage = false
const clients = new Set<WorkspaceOwner["queryClient"]>()
function Probe() {
  const workspace = useWorkspaceOwner()
  clients.add(workspace.queryClient)
  const value = { workspace, agents: useAgentContext(), channel: useChannel(), inbox: useInboxCount(), flags: useFlagCount(),
    inboxPages: useWorkspaceInbox(listsEnabled), flagPages: useWorkspaceFlags(listsEnabled),
    markAll: useMarkAllInboxRead(), unflag: useUnflagWorkspaceMessage(),
  }
  useLayoutEffect(() => { current = value })
  return <output data-testid="workspace-state">{value.agents.loading ? "loading" : workspace.application.userId}</output>
}
function tree(userId = "viewer-a", workspaceId = "workspace-a") {
  return <ApplicationQueryProvider userId={userId}>
    <WorkspaceProvider workspaceId={workspaceId} slug={workspaceId}>
      <AgentProvider workspaceId={workspaceId}>
        <ChannelProvider workspaceId={workspaceId}>
          <InboxCountProvider><FlagCountProvider><Probe />{showCreatePage && <CreateAgentPage />}</FlagCountProvider></InboxCountProvider>
        </ChannelProvider>
      </AgentProvider>
    </WorkspaceProvider>
  </ApplicationQueryProvider>
}
async function mount() {
  const renderer = render(tree())
  await waitFor(() => {
    expect(current.agents.loading).toBe(false)
    expect(current.inbox.resolved).toBe(true)
    expect(current.channel.loading).toBe(false)
    expect(current.agents.pins.size).toBe(2)
  })
  return renderer
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.userId = "viewer-a"
  mocks.ws = null
  listsEnabled = false
  showCreatePage = false
  mocks.save = null
  mocks.listAgents.mockResolvedValue([])
  mocks.listRuntimes.mockResolvedValue([])
  mocks.listAgentLinks.mockResolvedValue([])
  mocks.listAgentPins.mockImplementation(() => Promise.resolve(pins()))
  mocks.listAgentActiveTaskCounts.mockResolvedValue({ counts: {} })
  mocks.listWorkspaceActiveTasks.mockResolvedValue({ tasks: [] })
  mocks.listChannels.mockResolvedValue([{ id: "ch-a", name: "default" }, { id: "ch-b", name: "work" }])
  mocks.getInboxCount.mockResolvedValue({ count: 5 })
  mocks.getFlaggedCount.mockResolvedValue({ count: 2 })
  mocks.listInboxItems.mockResolvedValue({ items: [{ id: "inbox-a", latest_response: "newer first-page content", latest_response_at: "2026-10-01T02:00:00Z" }], has_more: true })
  mocks.listFlaggedItems.mockResolvedValue({ items: [{ id: "flag-a", message_id: "message-a", flagged_at: "2026-10-01T02:00:00Z" }], has_more: false })
  mocks.fetchModelOptions.mockResolvedValue({})
  mocks.createEmailAccount.mockResolvedValue({ id: "email-a" })
})
afterEach(async () => {
  await act(async () => {
    vi.useRealTimers()
    focusManager.setFocused(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const client of clients) client.clear()
    clients.clear()
  })
})

describe("native workspace ownership", () => {
  it.each(["reload", "email"] as const)("create-page intent stays quiet after retirement during %s", async (stage) => {
    showCreatePage = true
    const refresh = held<unknown[]>()
    const email = held<unknown>()
    mocks.createAgent.mockResolvedValueOnce({ id: "created-in-a" })
    const renderer = await mount()
    if (stage === "reload") mocks.listAgents.mockReturnValueOnce(refresh.promise)
    else mocks.createEmailAccount.mockReturnValueOnce(email.promise)
    let operation!: Promise<boolean>
    act(() => { operation = mocks.save!({ name: "A agent", description: "", instructions: "", runtime_id: "runtime-a", custom_email: { emailAddress: "a@example.test" } }) })
    await waitFor(() => stage === "reload" ? expect(mocks.listAgents).toHaveBeenCalledTimes(2) : expect(mocks.createEmailAccount).toHaveBeenCalledOnce())
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b")) })
    let result: boolean | undefined
    await act(async () => { refresh.resolve([]); email.resolve({ id: "email-a" }); result = await operation })
    expect(result).toBe(false)
    expect(mocks.successToast).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.router.push).not.toHaveBeenCalled()
    if (stage === "reload") expect(mocks.createEmailAccount).not.toHaveBeenCalled()
    else expect(mocks.createEmailAccount.mock.calls[0][3].assertActive).toBeTypeOf("function")
    renderer.unmount()
  })

  it("active create-page email failure remains visible and keeps navigation", async () => {
    showCreatePage = true
    mocks.createAgent.mockResolvedValueOnce({ id: "created-in-a" })
    mocks.createEmailAccount.mockRejectedValueOnce(new Error("active email failure"))
    const renderer = await mount()
    let result: boolean | undefined
    await act(async () => { result = await mocks.save!({ name: "A agent", description: "", instructions: "", runtime_id: "runtime-a", custom_email: { emailAddress: "a@example.test" } }) })
    expect(result).toBe(true)
    expect(mocks.toast).toHaveBeenCalledWith("active email failure")
    expect(mocks.router.push).toHaveBeenCalledWith("/w/workspace-a/agents/created-in-a/chat")
    renderer.unmount()
  })
  it("real Strict Mode replay retains its owner and real unmount clears Query", async () => {
    const renderer = render(<React.StrictMode>{tree()}</React.StrictMode>)
    await waitFor(() => expect(current.agents.loading).toBe(false))
    const source = current.workspace
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(source.application.lifecycle.get().active).toBe(true)
    expect(source.lifecycle.get().active).toBe(true)
    expect(source.queryClient.getQueryData(source.key("agents"))).toEqual([])
    renderer.unmount()
    await waitFor(() => expect(source.queryClient.getQueryCache().getAll()).toHaveLength(0))
    expect(source.application.lifecycle.get().active).toBe(false)
  })

  it("InfiniteQuery appends unique inbox rows and keeps the cursor in Query", async () => {
    listsEnabled = true
    const renderer = await mount()
    await waitFor(() => expect(current.inboxPages.items).toHaveLength(1))
    mocks.listInboxItems.mockResolvedValueOnce({ items: [{ id: "inbox-a", latest_response: "older overlapping content", latest_response_at: "2026-10-01T02:00:00Z" }, { id: "inbox-b", latest_response_at: "2026-10-01T01:00:00Z" }], has_more: false })
    await act(async () => { await current.inboxPages.fetchNextPage() })
    await waitFor(() => expect(current.inboxPages.items.map((item) => item.id)).toEqual(["inbox-a", "inbox-b"]))
    expect(current.inboxPages.items[0].latest_response).toBe("newer first-page content")
    expect(current.inboxPages.data?.pageParams).toEqual([undefined, "2026-10-01T02:00:00Z"])
    expect(current.inboxPages.hasNextPage).toBe(false)
    expect(mocks.listInboxItems.mock.calls[1][2].signal).toBeInstanceOf(AbortSignal)
    renderer.unmount()
  })

  it("overlapping flag pages retain the first row content, ordering, and cursor", async () => {
    listsEnabled = true
    mocks.listFlaggedItems.mockResolvedValueOnce({ items: [{ id: "flag-a", message_content: "newer first-page content", flagged_at: "2026-10-01T02:00:00Z" }], has_more: true })
    const renderer = await mount()
    await waitFor(() => expect(current.flagPages.items).toHaveLength(1))
    mocks.listFlaggedItems.mockResolvedValueOnce({ items: [{ id: "flag-a", message_content: "older overlapping content", flagged_at: "2026-10-01T02:00:00Z" }, { id: "flag-b", flagged_at: "2026-10-01T01:00:00Z" }], has_more: false })
    await act(async () => { await current.flagPages.fetchNextPage() })
    await waitFor(() => expect(current.flagPages.items.map((item) => item.id)).toEqual(["flag-a", "flag-b"]))
    expect(current.flagPages.items[0].message_content).toBe("newer first-page content")
    expect(current.flagPages.data?.pageParams).toEqual([undefined, "2026-10-01T02:00:00Z"])
    expect(current.flagPages.hasNextPage).toBe(false)
    renderer.unmount()
  })

  it("mark-all publishes immediately and rolls back pages plus count on failure", async () => {
    listsEnabled = true
    const request = held<void>()
    mocks.markAllInboxRead.mockReturnValueOnce(request.promise)
    const renderer = await mount()
    await waitFor(() => expect(current.inboxPages.items).toHaveLength(1))
    let operation!: Promise<void>
    act(() => { operation = current.markAll.mutateAsync().catch(() => undefined) })
    await waitFor(() => {
      expect(current.inboxPages.items).toHaveLength(0)
      expect(current.inbox.count).toBe(0)
    })
    await act(async () => { request.reject(new Error("read failed")); await operation })
    await waitFor(() => {
      expect(current.inboxPages.items).toHaveLength(1)
      expect(current.inbox.count).toBe(5)
    })
    expect(mocks.notify).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("unflag removes the canonical row immediately and restores row plus count on failure", async () => {
    listsEnabled = true
    const request = held<void>()
    mocks.unflagMessage.mockReturnValueOnce(request.promise)
    const renderer = await mount()
    await waitFor(() => expect(current.flagPages.items).toHaveLength(1))
    let operation!: Promise<void>
    act(() => { operation = current.unflag.mutateAsync("message-a").catch(() => undefined) })
    await waitFor(() => {
      expect(current.flagPages.items).toHaveLength(0)
      expect(current.flags.count).toBe(1)
    })
    await act(async () => { request.reject(new Error("unflag failed")); await operation })
    await waitFor(() => {
      expect(current.flagPages.items).toHaveLength(1)
      expect(current.flags.count).toBe(2)
    })
    renderer.unmount()
  })
  it.each(["pin", "unpin", "reorder-pins", "reorder-unpinned"] as const)("%s publishes before HTTP and rolls back failure", async (kind) => {
    const request = held<unknown>()
    const mock = { pin: mocks.pinAgent, unpin: mocks.unpinAgent, "reorder-pins": mocks.reorderAgentPins, "reorder-unpinned": mocks.reorderUnpinnedAgents }[kind]
    mock.mockReturnValueOnce(request.promise)
    const renderer = await mount()
    let operation!: Promise<void>
    act(() => {
      operation = kind === "pin" ? current.agents.handlePinAgent("c")
        : kind === "unpin" ? current.agents.handleUnpinAgent("a")
        : kind === "reorder-pins" ? current.agents.handleReorderPins(["b", "a"])
        : current.agents.handleReorderUnpinned(["d", "c"])
    })
    await waitFor(() => {
      expect(mock).toHaveBeenCalledOnce()
      if (kind === "pin") expect(current.agents.pins.has("c")).toBe(true)
      if (kind === "unpin") expect(current.agents.pins.has("a")).toBe(false)
      if (kind === "reorder-pins") expect(current.agents.pins.get("b")?.position).toBe(0)
      if (kind === "reorder-unpinned") expect(current.agents.unpinnedOrder.get("d")).toBe(0)
    })
    await act(async () => { request.reject(new Error("failed")); await operation })
    await waitFor(() => {
      expect(current.agents.pins.size).toBe(2)
      expect(current.agents.pins.get("a")?.position).toBe(0)
      expect(current.agents.unpinnedOrder.get("c")).toBe(0)
    })
    expect(mocks.toast).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it.each(["resolve", "reject"] as const)("retired mutation %s stays out of the next account", async (completion) => {
    const request = held<unknown>()
    mocks.pinAgent.mockReturnValueOnce(request.promise)
    const renderer = await mount()
    const source = current.workspace
    let operation!: Promise<void>
    act(() => { operation = current.agents.handlePinAgent("c") })
    await waitFor(() => expect(mocks.pinAgent).toHaveBeenCalledOnce())
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b")) })
    await waitFor(() => expect(current.workspace.application.userId).toBe("viewer-b"))
    await act(async () => {
      if (completion === "resolve") request.resolve({ pinned: true })
      else request.reject(new Error("old account error"))
      await operation
    })
    await waitFor(() => expect(current.agents.pins.size).toBe(2))
    expect(source.lifecycle.get().active).toBe(false)
    expect(source.application.lifecycle.get().active).toBe(false)
    expect(current.agents.pins.has("c")).toBe(false)
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.pinAgent.mock.calls[0][2].assertActive).toBeTypeOf("function")
    renderer.unmount()
  })

  it("failure followed by a held settled refresh is quiet if the account retires during that refresh", async () => {
    const mutation = held<unknown>()
    const refresh = held<ReturnType<typeof pins>>()
    mocks.pinAgent.mockReturnValueOnce(mutation.promise)
    const renderer = await mount()
    mocks.listAgentPins.mockReturnValueOnce(refresh.promise)
    let operation!: Promise<void>
    act(() => { operation = current.agents.handlePinAgent("c") })
    await waitFor(() => expect(mocks.pinAgent).toHaveBeenCalledOnce())
    await act(async () => { mutation.reject(new Error("pin failed before retirement")) })
    await waitFor(() => expect(mocks.listAgentPins).toHaveBeenCalledTimes(2))
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b")) })
    await act(async () => { refresh.resolve(pins()); await operation })
    await waitFor(() => expect(current.agents.loading).toBe(false))
    expect(current.workspace.application.userId).toBe("viewer-b")
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(current.agents.pins.has("c")).toBe(false)
    renderer.unmount()
  })

  it("successful create cannot return an agent after retirement during its reload", async () => {
    const refresh = held<unknown[]>()
    mocks.createAgent.mockResolvedValueOnce({ id: "created-in-a" })
    const renderer = await mount()
    mocks.listAgents.mockReturnValueOnce(refresh.promise)
    let operation!: ReturnType<typeof current.agents.handleCreateAgent>
    act(() => { operation = current.agents.handleCreateAgent({ name: "A agent", runtime_id: "runtime-a" }) })
    await waitFor(() => expect(mocks.listAgents).toHaveBeenCalledTimes(2))
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b")) })
    let result: Awaited<typeof operation> | undefined
    await act(async () => { refresh.resolve([]); result = await operation })
    expect(result).toBeNull()
    expect(current.workspace.application.userId).toBe("viewer-b")
    expect(mocks.toast).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("keeps selection scoped across workspace and account changes", async () => {
    const renderer = await mount()
    act(() => { current.channel.setActiveChannel("work") })
    expect(current.channel.activeChannel).toBe("work")
    act(() => renderer.rerender(tree("viewer-a", "workspace-b")))
    await waitFor(() => expect(current.workspace.workspaceId).toBe("workspace-b"))
    expect(current.channel.activeChannel).toBe("default")
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b", "workspace-a")) })
    await waitFor(() => expect(current.workspace.application.userId).toBe("viewer-b"))
    expect(current.channel.activeChannel).toBe("default")
    expect(localStorage.getItem("alook:channel:v2:viewer-a:workspace-a:workspace")).toBe("work")
    renderer.unmount()
  })

  it("idle task loading reads counts; positive counts then enable details", async () => {
    const renderer = await mount()
    expect(mocks.listAgentActiveTaskCounts).toHaveBeenCalledOnce()
    expect(mocks.listWorkspaceActiveTasks).not.toHaveBeenCalled()
    mocks.listAgentActiveTaskCounts.mockResolvedValue({ counts: { a: 1 } })
    mocks.listWorkspaceActiveTasks.mockResolvedValue({ tasks: [{ id: "task", agent_id: "a", status: "running" }] })
    act(() => mocks.ws?.({ type: "task.updated", workspaceId: "workspace-a", agentId: "a", status: "running" }))
    await waitFor(() => expect(mocks.listWorkspaceActiveTasks).toHaveBeenCalledOnce())
    await waitFor(() => expect(current.agents.activeTaskCounts.a).toBe(1))
    expect(mocks.listAgentActiveTaskCounts.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    renderer.unmount()
  })

  it("polls counts while idle and details while tasks are active, with one polling observer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    focusManager.setFocused(true)
    const renderer = await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(mocks.listAgentActiveTaskCounts).toHaveBeenCalledTimes(2)
    expect(mocks.listWorkspaceActiveTasks).not.toHaveBeenCalled()
    mocks.listAgentActiveTaskCounts.mockResolvedValue({ counts: { a: 1 } })
    mocks.listWorkspaceActiveTasks.mockResolvedValue({ tasks: [{ id: "task", agent_id: "a", status: "running" }] })
    await act(async () => { await current.workspace.queryClient.refetchQueries({ queryKey: current.workspace.key("active-task-counts"), exact: true }) })
    await waitFor(() => expect(mocks.listWorkspaceActiveTasks).toHaveBeenCalledOnce())
    const countCalls = mocks.listAgentActiveTaskCounts.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(mocks.listWorkspaceActiveTasks).toHaveBeenCalledTimes(2)
    expect(mocks.listAgentActiveTaskCounts).toHaveBeenCalledTimes(countCalls)
    renderer.unmount()
  })

  it.each(["resolve", "reject"] as const)("retired read %s cannot publish into the replacement account", async (completion) => {
    const request = held<unknown[]>()
    mocks.listAgents.mockReturnValueOnce(request.promise)
    const renderer = render(tree())
    await waitFor(() => expect(mocks.listAgents).toHaveBeenCalledOnce())
    const source = current.workspace
    act(() => { mocks.userId = "viewer-b"; renderer.rerender(tree("viewer-b")) })
    await waitFor(() => expect(current.agents.loading).toBe(false))
    await act(async () => {
      if (completion === "resolve") request.resolve([{ id: "old-private-agent" }])
      else request.reject(new Error("old account read error"))
    })
    expect(current.workspace.application.userId).toBe("viewer-b")
    expect(current.agents.agents).toEqual([])
    expect(source.lifecycle.get().active).toBe(false)
    expect(mocks.listAgents.mock.calls[0][1].signal.aborted).toBe(true)
    expect(mocks.toast).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("initial count and local decrement do not trigger a completed notification", async () => {
    const request = held<{ count: number }>()
    const renderer = await mount()
    expect(mocks.notify).not.toHaveBeenCalled()
    mocks.getInboxCount.mockReturnValueOnce(request.promise)
    let fetch!: Promise<unknown>
    act(() => { fetch = current.workspace.queryClient.refetchQueries({ queryKey: current.inbox.queryKey, exact: true }) })
    await waitFor(() => expect(mocks.getInboxCount).toHaveBeenCalledTimes(2))
    act(() => current.inbox.decrement())
    await waitFor(() => expect(current.inbox.count).toBe(4))
    await act(async () => { request.resolve({ count: 5 }); await fetch })
    await waitFor(() => expect(current.inbox.count).toBe(5))
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(current.inbox.notificationToken).toBe(0)
    mocks.getInboxCount.mockResolvedValue({ count: 6 })
    await act(async () => { await current.workspace.queryClient.refetchQueries({ queryKey: current.inbox.queryKey, exact: true }) })
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
    expect(current.inbox.notificationToken).toBe(1)
    renderer.unmount()
  })

  it("filter change establishes its own server baseline", async () => {
    const renderer = await mount()
    mocks.getInboxCount.mockResolvedValue({ count: 50 })
    act(() => setInboxFilterTypes(current.workspace.application, ["user_dm_message", "calendar_event"]))
    await waitFor(() => expect(current.inbox.count).toBe(50))
    expect(mocks.notify).not.toHaveBeenCalled()
    mocks.getInboxCount.mockResolvedValue({ count: 51 })
    await act(async () => { await current.workspace.queryClient.refetchQueries({ queryKey: current.inbox.queryKey, exact: true }) })
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce())
    renderer.unmount()
  })
})
