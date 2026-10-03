import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { FlagCountProvider, useFlagCount } from "@/contexts/flag-count-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { useChatData } from "./use-chat-data"
import { useMessageFlags } from "../use-message-flags"
import { useChatSheets } from "../use-chat-sheets"
import { publishWorkspaceIssueEvent } from "@/lib/workspace-issue-events"
import type { ChatFlagsData } from "@/lib/workspace-chat-flags"
import type { WorkspaceIssueDetail } from "@/lib/workspace-issue-reconciliation"
import type { Issue, Message, WsMessage, Artifact } from "@alook/shared"

const error = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => ({ user: "secondary-user" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: auth.user } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("sonner", () => ({ toast: { error } }))
let owner: WorkspaceOwner
let flags: ReturnType<typeof useMessageFlags>
let sheets: ReturnType<typeof useChatSheets>
let count: number
let ready = false
let serverCount = 2
let countReads = 0
let requests: Array<{ path: string; method: string; resolve: (response: Response) => void; signal?: AbortSignal }>
const callbacks = new Set<(message: WsMessage) => void>()
const subscribe = (callback: (message: WsMessage) => void) => { callbacks.add(callback); return () => { callbacks.delete(callback) } }
const ws = (message: WsMessage) => { publishWorkspaceIssueEvent(owner, message); callbacks.forEach((callback) => callback(message)) }
function Probe({ target = "A", switchFailedA = false }: { target?: string; switchFailedA?: boolean }) {
  const currentOwner = useWorkspaceOwner()
  const chat = useChatData(currentOwner, target, target)
  const currentFlags = useMessageFlags(currentOwner, chat.view, target)
  const currentSheets = useChatSheets(currentOwner, chat.view)
  const currentCount = useFlagCount().count
  React.useLayoutEffect(() => { owner = currentOwner; ready = true; flags = currentFlags; sheets = currentSheets; count = currentCount })
  React.useLayoutEffect(() => {
    if (switchFailedA && currentSheets.selectedIssueId === "A" && currentOwner.queryClient.getQueryState(currentOwner.key("issues", "detail", "A"))?.status === "error") void currentSheets.openIssue("B")
  })
  return null
}
function App(props: { target?: string; switchFailedA?: boolean; workspace?: string; user?: string }) { return <ApplicationQueryProvider userId={props.user ?? "secondary-user"}><WorkspaceProvider workspaceId={props.workspace ?? "workspace"} slug={props.workspace ?? "workspace"}><FlagCountProvider><Probe {...props} /></FlagCountProvider></WorkspaceProvider></ApplicationQueryProvider> }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const message = (id: string, content = id): Message => ({ id, conversation_id: "conv-A", role: "event", content, task_id: null, attachment_ids: null, created_at: "2026-10-01T00:00:00Z" })
function detail(id = "A", extra: Partial<Issue> = {}): WorkspaceIssueDetail {
  return { issue: { id, agent_id: "agent", workspace_id: "workspace", title: id, description: null, status: "open", conversation_id: `conv-${id}`, latest_task_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra } as Issue, messages: [message("initial")], comments: [], artifacts: [] }
}
const artifact: Artifact = { id: "artifact", agent_id: "agent", conversation_id: "conv-A", filename: "report.pdf", content_type: "application/pdf", size: 123, source: "agent", has_thumbnail: false, created_at: "2026-10-01T00:00:00Z" }
async function selectIssue(id = "A") { await waitFor(() => expect(ready).toBe(true)); act(() => { void sheets.openIssue(id) }); return waitFor(() => expect(requests.some((request) => request.path.startsWith(`/api/issues/${id}?`))).toBe(true)) }
beforeEach(async () => {
  await clearAllPersistedCaches(); auth.user = "secondary-user"; ready = false; serverCount = 2; countReads = 0; requests = []; error.mockClear(); callbacks.clear()
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
    if (path.startsWith("/api/flags/count")) { countReads++; return Promise.resolve(reply({ count: serverCount })) }
    if (path.startsWith("/api/flags?") && !options.method) return Promise.resolve(reply({ message_ids: ["flagged"] }))
    return new Promise<Response>((resolve) => requests.push({ path, method: options.method ?? "GET", resolve, signal: options.signal ?? undefined }))
  }))
})
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})

describe("chat secondary canonical resources", () => {
  it("current flag failure rolls back canonical ids and count", async () => {
    render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    let toggled!: Promise<void>
    act(() => { toggled = flags.handleToggleFlag("new") })
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(flags.flaggedIds.has("new")).toBe(true)
    expect(count).toBe(3)
    await act(async () => { requests[0].resolve(reply({ error: "failed" }, 500)); await toggled })
    await waitFor(() => expect(flags.flaggedIds.has("new")).toBe(false))
    expect(count).toBe(2)
    expect(owner.queryClient.getQueryData<ChatFlagsData>(owner.key("chat", "flags", "A"))?.ids).toEqual(["flagged"])
  })
  it("retired flag 401 cannot redirect or change the next conversation ids", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    let toggled!: Promise<void>
    act(() => { toggled = flags.handleToggleFlag("old") })
    await waitFor(() => expect(requests).toHaveLength(1))
    const actualWindow = window, assign = vi.fn()
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await act(async () => { requests[0].resolve(reply({}, 401)); await toggled })
    expect(flags.flaggedIds.has("old")).toBe(false)
    expect(assign).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
  it.each([200, 500])("retired flag response %s settles the original resource and count before reopening A", async (status) => {
    const mounted = render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    let toggled!: Promise<void>
    act(() => { toggled = flags.handleToggleFlag("unconfirmed") })
    await waitFor(() => expect(requests).toHaveLength(1))
    await waitFor(() => expect(count).toBe(3))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await act(async () => { requests[0].resolve(reply(status === 200 ? { flagged: true } : { error: "failed" }, status)); await toggled })
    expect(owner.queryClient.getQueryData<ChatFlagsData>(owner.key("chat", "flags", "A"))?.ids).toEqual(["flagged"])
    await waitFor(() => expect(count).toBe(2))
    expect(owner.queryClient.getQueryState(owner.key("chat", "flags", "A"))?.isInvalidated).toBe(true)
    act(() => mounted.rerender(<App target="A" />))
    await waitFor(() => expect(owner.queryClient.getQueryState(owner.key("chat", "flags", "A"))?.fetchStatus).toBe("idle"))
    expect(flags.flaggedIds.has("unconfirmed")).toBe(false)
  })
  it("settling old A preserves a newer confirmed count after B succeeds and refreshes", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    let old!: Promise<void>, current!: Promise<void>
    act(() => { old = flags.handleToggleFlag("old-A") })
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    act(() => { current = flags.handleToggleFlag("confirmed-B") })
    await waitFor(() => expect(requests).toHaveLength(2))
    serverCount = 3
    await act(async () => { requests[1].resolve(reply({ flagged: true })); await current })
    await waitFor(() => expect(countReads).toBe(2))
    await waitFor(() => expect(count).toBe(3))
    await act(async () => { requests[0].resolve(reply({ error: "failed" }, 500)); await old })
    await waitFor(() => expect(owner.queryClient.getQueryState(owner.key("chat", "flags", "A"))?.isInvalidated).toBe(true))
    expect(count).toBe(3)
  })
  it("two failures remove their own pending count deltas without erasing the other transaction", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    let old!: Promise<void>, current!: Promise<void>
    act(() => { old = flags.handleToggleFlag("old-A") })
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    act(() => { current = flags.handleToggleFlag("pending-B") })
    await waitFor(() => expect(requests).toHaveLength(2))
    await waitFor(() => expect(count).toBe(4))
    await act(async () => { requests[0].resolve(reply({ error: "failed" }, 500)); await old })
    await waitFor(() => expect(count).toBe(3))
    expect(flags.flaggedIds.has("pending-B")).toBe(true)
    await act(async () => { requests[1].resolve(reply({ error: "failed" }, 500)); await current })
    await waitFor(() => expect(count).toBe(2))
    expect(flags.flaggedIds.has("pending-B")).toBe(false)
  })
  it("workspace A→B retirement settles A's original cached transaction before returning to A", async () => {
    const mounted = render(<App workspace="workspace-A" />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    const original = owner
    let old!: Promise<void>
    act(() => { old = flags.handleToggleFlag("unconfirmed") })
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => mounted.rerender(<App workspace="workspace-B" />))
    await waitFor(() => expect(owner.workspaceId).toBe("workspace-B"))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    expect(original.lifecycle.get().active).toBe(false)
    await act(async () => { requests[0].resolve(reply({ error: "failed" }, 500)); await old })
    expect(original.queryClient.getQueryData<ChatFlagsData>(original.key("chat", "flags", "A"))?.ids).toEqual(["flagged"])
    expect(original.queryClient.getQueryData<{ count: number }>(original.key("flag-count"))?.count).toBe(2)
    expect(flags.flaggedIds.has("unconfirmed")).toBe(false)
    expect(count).toBe(2)
    act(() => mounted.rerender(<App workspace="workspace-A" />))
    await waitFor(() => expect(owner.workspaceId).toBe("workspace-A"))
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    expect(flags.flaggedIds.has("unconfirmed")).toBe(false)
    expect(count).toBe(2)
  })
  it.each([false, true])("old workspace settlement cannot recreate or mutate a replaced Query, replacement=%s", async (replacement) => {
    const mounted = render(<App workspace="workspace-A" />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    await waitFor(() => expect(count).toBe(2))
    const original = owner, key = original.key("chat", "flags", "A"), countKey = original.key("flag-count")
    let old!: Promise<void>
    act(() => { old = flags.handleToggleFlag("unconfirmed") })
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => mounted.rerender(<App workspace="workspace-B" />))
    await waitFor(() => expect(owner.workspaceId).toBe("workspace-B"))
    await waitFor(() => expect(count).toBe(2))
    act(() => {
      original.queryClient.removeQueries({ queryKey: original.key() })
      if (replacement) {
        original.queryClient.setQueryData<ChatFlagsData>(key, { ids: ["new-confirmed", "unconfirmed"], revision: 1, writes: { unconfirmed: { flagged: true, revision: 1 } } })
        original.queryClient.setQueryData(countKey, { count: 10, confirmedCount: 9, revision: 1, pending: { "1": { delta: 1, revision: 1 } } })
      }
    })
    const nextFlags = original.queryClient.getQueryData(key), nextCount = original.queryClient.getQueryData(countKey)
    await act(async () => { requests[0].resolve(reply({ error: "failed" }, 500)); await old })
    expect(original.queryClient.getQueryData(key)).toBe(nextFlags)
    expect(original.queryClient.getQueryData(countKey)).toBe(nextCount)
    if (replacement) {
      expect(original.queryClient.getQueryState(key)?.isInvalidated).toBe(false)
      expect(original.queryClient.getQueryState(countKey)?.isInvalidated).toBe(false)
    } else expect(original.queryClient.getQueryCache().findAll({ queryKey: original.key() })).toEqual([])
    expect(count).toBe(2)
  })
  it("account retirement rejects the old flag 401 without recreating old facts or touching the next account", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    const original = owner
    let old!: Promise<void>
    act(() => { old = flags.handleToggleFlag("old-account") })
    await waitFor(() => expect(requests).toHaveLength(1))
    const actualWindow = window, assign = vi.fn()
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    auth.user = "next-user"
    act(() => mounted.rerender(<App user="next-user" />))
    await waitFor(() => expect(owner.application.userId).toBe("next-user"))
    await waitFor(() => expect(count).toBe(2))
    await waitFor(() => expect(original.queryClient.getQueryCache().getAll()).toEqual([]))
    await act(async () => { requests[0].resolve(reply({}, 401)); await old })
    expect(assign).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(original.queryClient.getQueryCache().getAll()).toEqual([])
    expect(flags.flaggedIds.has("old-account")).toBe(false)
    expect(count).toBe(2)
  })
  it.each([200, 401])("retired issue response %s cannot replace the new selection or redirect", async (status) => {
    render(<App />); await selectIssue("A")
    const first = requests[0]
    const actualWindow = window, assign = vi.fn()
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    await selectIssue("B")
    await act(async () => requests[1].resolve(reply(detail("B"))))
    await waitFor(() => expect(sheets.issueDetail?.issue.id).toBe("B"))
    await act(async () => first.resolve(reply(status === 200 ? detail("A") : {}, status)))
    await waitFor(() => expect(owner.queryClient.getQueryState(owner.key("issues", "detail", "A"))?.fetchStatus).toBe("idle"))
    expect(sheets.issueDetail?.issue.id).toBe("B")
    expect(assign).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
  it("WS message and status survive a held issue refetch, and selected artifact derives the canonical row", async () => {
    render(<App />); await selectIssue()
    await act(async () => requests[0].resolve(reply({ ...detail(), artifacts: [artifact] })))
    await waitFor(() => expect(sheets.issueDetail?.issue.id).toBe("A"))
    act(() => sheets.setSelectedArtifact(artifact))
    await waitFor(() => expect(sheets.selectedArtifact?.filename).toBe("report.pdf"))
    act(() => { void sheets.openIssue("A") })
    await waitFor(() => expect(requests).toHaveLength(2))
    act(() => ws({ type: "conversation.message", conversationId: "conv-A", message: message("ws-status", "Issue status changed: open -> closed") }))
    await act(async () => requests[1].resolve(reply({ ...detail(), artifacts: [{ ...artifact, filename: "renamed.pdf" }] })))
    await waitFor(() => expect(owner.queryClient.getQueryState(owner.key("issues", "detail", "A"))?.fetchStatus).toBe("idle"))
    expect(sheets.issueDetail?.messages.map((row) => row.id)).toEqual(["initial", "ws-status"])
    expect(sheets.issueDetail?.issue.status).toBe("closed")
    expect(sheets.selectedArtifact?.filename).toBe("renamed.pdf")
  })
  it("an earlier init flags snapshot cannot replace a live optimistic flag write", async () => {
    render(<App />)
    await waitFor(() => expect(flags.flaggedIds.has("flagged")).toBe(true))
    const key = owner.key("chat", "flags", "A")
    const started = owner.queryClient.getQueryData<ChatFlagsData>(key)?.revision ?? 0
    let toggled!: Promise<void>
    act(() => { toggled = flags.handleToggleFlag("accepted") })
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => { requests[0].resolve(reply({ flagged: true })); await toggled })
    act(() => owner.queryClient.setQueryData<ChatFlagsData>(key, { ids: ["flagged"], requestRevision: started }))
    await waitFor(() => expect(flags.flaggedIds.has("accepted")).toBe(true))
    expect(owner.queryClient.getQueryData<ChatFlagsData>(key)?.ids).toEqual(["flagged", "accepted"])
    expect(owner.queryClient.getQueryData<ChatFlagsData>(key)?.requestRevision).toBeUndefined()
  })
  it("an error effect queued for A cannot borrow B selection after layout switches the sheet", async () => {
    render(<App switchFailedA />); await selectIssue()
    await act(async () => requests[0].resolve(reply({ error: "A failed" }, 400)))
    await waitFor(() => expect(requests).toHaveLength(2), { timeout: 2000 })
    await act(async () => requests[1].resolve(reply({ error: "A failed" }, 400)))
    await waitFor(() => expect(requests.some((request) => request.path.startsWith("/api/issues/B?"))).toBe(true))
    expect(sheets.selectedIssueId).toBe("B")
    expect(sheets.issueSheetOpen).toBe(true)
    expect(error).not.toHaveBeenCalled()
    await act(async () => requests.find((request) => request.path.startsWith("/api/issues/B?"))!.resolve(reply(detail("B"))))
    await waitFor(() => expect(sheets.issueDetail?.issue.id).toBe("B"))
  })
  it("current issue failure closes the sheet and reports its normal error", async () => {
    render(<App />); await selectIssue()
    await act(async () => requests[0].resolve(reply({ error: "unavailable" }, 400)))
    await waitFor(() => expect(requests).toHaveLength(2), { timeout: 2000 })
    await act(async () => requests[1].resolve(reply({ error: "unavailable" }, 400)))
    await waitFor(() => expect(sheets.issueSheetOpen).toBe(false))
    expect(error).toHaveBeenCalledTimes(1)
  })
})
