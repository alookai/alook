import { useLayoutEffect } from "react"
import { publishWorkspaceChatEvent } from "@/lib/workspace-chat-events"
import "fake-indexeddb/auto"
import React from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { persistQueryClientSave } from "@tanstack/react-query-persist-client"
import { createApplicationOwner, ApplicationQueryProvider } from "@/lib/application-owner"
import { createWorkspaceOwner, useWorkspaceOwner, WorkspaceProvider, type WorkspaceOwner } from "@/contexts/workspace-context"
import { createIdbPersister, clearAllPersistedCaches, PERSIST_BUSTER } from "@/lib/query-persister"
import { shouldPersistApplicationQuery } from "@/lib/workspace-chat-persistence"
import { mergeCachedMessages, setConvExtras, setLastOpenConversation, getCacheMeta, getLastOpenConversation, chatExtrasKey, chatMessagesKey, type ChatMessagesData, type ChatExtras } from "@/lib/chat-cache"
import type { Conversation, Message, Artifact, TaskApi, WsMessage } from "@alook/shared"
import { useAgentChat } from "./use-agent-chat"
import { useChatData } from "./workspace/use-chat-data"
const { useChatSheets: useRealChatSheets } = await vi.importActual<typeof import("./use-chat-sheets")>("./use-chat-sheets")
let sharedSheet: ReturnType<typeof useRealChatSheets>
function SharedIssueConsumer() { const owner = useWorkspaceOwner(); const chat = useChatData(owner, "shared-issue", "A"); const current = useRealChatSheets(owner, chat.view); const openIssue = current.openIssue; React.useLayoutEffect(() => { sharedSheet = current }); React.useEffect(() => { void openIssue("issue") }, [openIssue]); return null }

const mocks = vi.hoisted(() => ({ user: "chat-user", error: vi.fn() }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: mocks.user } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useParams: () => ({ id: "agent" }), useSearchParams: () => new URLSearchParams() }))
vi.mock("sonner", () => ({ toast: { error: mocks.error } }))
vi.mock("@/lib/analytics", () => ({ trackAgentChatOpened: vi.fn(), trackMessageSent: vi.fn() }))

vi.mock("@/contexts/agent-context", () => ({ useAgentContext: () => ({ agents: [], runtimes: [], agentLinks: [], activeTaskCounts: {}, subscribeWs, subscribeReconnect }) }))
vi.mock("@/contexts/inbox-count-context", () => ({ useInboxCount: () => ({ refresh: vi.fn() }) }))
vi.mock("@/contexts/channel-context", () => ({ useChannel: () => ({ activeChannel: "general", loading: false, setAgentId: vi.fn() }) }))
vi.mock("@/contexts/agent-chat-sheet-context", () => ({ useAgentChatSheet: () => ({ openAgentChat: vi.fn() }) }))
vi.mock("@/hooks/use-message-flags", () => ({ useMessageFlags: () => ({ flaggedIds: new Set(), setFlaggedIds: vi.fn(), handleToggleFlag: vi.fn() }) }))
vi.mock("@/hooks/use-chat-sheets", () => ({ useChatSheets: () => ({ artifactSheetOpen: false, setArtifactSheetOpen: vi.fn(), selectedArtifact: null, setSelectedArtifact: vi.fn(), emailSheetOpen: false, setEmailSheetOpen: vi.fn(), selectedEmailId: null, setSelectedEmailId: vi.fn(), calendarEventSheetOpen: false, setCalendarEventSheetOpen: vi.fn(), selectedCalendarEventId: null, setSelectedCalendarEventId: vi.fn(), issueSheetOpen: false, setIssueSheetOpen: vi.fn(), selectedIssueId: null, setSelectedIssueId: vi.fn(), issueDetail: null, setIssueDetail: vi.fn(), issueDetailLoading: false, issueTraceTasks: [], issueActiveTask: null, setIssueActiveTask: vi.fn(), openIssue: vi.fn(), issueConvId: null, issueTaskId: null }) }))
vi.mock("@/hooks/use-file-attachments", () => ({ useFileAttachments: () => ({ pendingFiles: [], setPendingFiles: vi.fn(), fileInputRef: { current: null }, addPendingFiles: vi.fn(), handleFileSelect: vi.fn(), removePendingFile: vi.fn(), dragging: false, handleDragEnter: vi.fn(), handleDragLeave: vi.fn(), handleDragOver: vi.fn(), handleDrop: vi.fn() }) }))
vi.mock("@/hooks/use-slash-command", () => ({ useSlashCommand: () => ({ activeSkill: null, clearActiveSkill: vi.fn(), setActiveSkill: vi.fn(), isOpen: false, handleSlashKeyDown: vi.fn(), skills: [] }) }))
vi.mock("@/components/agent-chat/chat-composer", () => ({ ChatComposer: React.forwardRef(function ChatComposer() { return <div data-testid="composer" /> }), RotatingPlaceholderOverlay: () => null }))
vi.mock("@/components/agent-chat/slash-command-popup", () => ({ SlashCommandPopup: () => null }))
vi.mock("@/components/agent-chat/artifact-sheet", () => ({ ArtifactSheet: () => null, formatSize: () => "123" }))
vi.mock("@/components/agent-chat/email-event-sheet", () => ({ EmailEventSheet: () => null }))
vi.mock("@/components/agent-chat/image-lightbox", () => ({ ImageLightbox: () => null }))
vi.mock("@/components/calendar/calendar-event-sheet", () => ({ CalendarEventSheet: () => null }))
vi.mock("@/components/issues/issue-sheet", () => ({ IssueSheet: () => null }))
vi.mock("@/components/agent-chat/message-list", () => ({
  AgentRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MessageItem: ({ msg, isThreadRoot, onReplyInThread, conversationType }: { msg: Message; isThreadRoot?: boolean; onReplyInThread?: (id: string) => void; conversationType?: string }) => <div data-testid={`view-${msg.id}`} data-thread-root={String(!!isThreadRoot)} data-conversation-type={conversationType}>{msg.content}{onReplyInThread && <button onClick={() => onReplyInThread(msg.id)}>Reply in thread</button>}</div>,
}))
import { AgentChatView } from "@/components/agent-chat/agent-chat-view"

const external = { setFlaggedIds: vi.fn(), setPendingFiles: vi.fn(), setInput: vi.fn(), setQuotedMessage: vi.fn(), setActiveSkill: vi.fn(), clearActiveSkill: vi.fn(), inputRef: { current: "" }, quotedMessageRef: { current: null }, pendingFilesRef: { current: [] }, activeSkillRef: { current: null }, draftMetaRestoredRef: { current: false }, readInput: () => external.inputRef.current, readQuotedMessage: () => external.quotedMessageRef.current, readPendingFiles: () => external.pendingFilesRef.current, readActiveSkill: () => external.activeSkillRef.current, markDraftRestored: () => { external.draftMetaRestoredRef.current = true } }
let latest: ReturnType<typeof useAgentChat>
let liveOwner: WorkspaceOwner
let held: Array<{ path: string; body?: BodyInit | null; method?: string; resolve: (response: Response) => void; signal?: AbortSignal }>
const subscriptions = new Set<(message: never) => void>()
const subscribeWs = (callback: (message: never) => void) => { subscriptions.add(callback); return () => { subscriptions.delete(callback) } }
const subscribeReconnect = () => () => {}
function conversation(id = "A", extra: Partial<Conversation> = {}): Conversation { return { id, agent_id: "agent", title: id, type: "email_event", channel: "general", created_at: "2026-10-01T12:00:00Z", ...extra } }
function message(id = "mA", conv = "A", extra: Partial<Message> = {}): Message { return { id, conversation_id: conv, role: "event", content: `Message ${id}`, task_id: null, attachment_ids: null, created_at: "2026-10-01T12:00:01Z", ...extra } }
const artifact: Artifact = { id: "fileA", conversation_id: "A", agent_id: "agent", filename: "report.pdf", content_type: "application/pdf", size: 123, source: "agent", has_thumbnail: false, created_at: "2026-10-01T12:00:02Z" }
function task(status = "queued"): TaskApi { return { id: "task-A", agent_id: "agent", runtime_id: "runtime", conversation_id: "A", workspace_id: "workspace", prompt: "Hello", status, priority: 0, dispatched_at: null, started_at: null, completed_at: null, result: null, error: null, created_at: "2026-10-01T12:00:00Z", type: "chat" } }
function ws(message: WsMessage) { publishWorkspaceChatEvent(liveOwner, message); for (const callback of subscriptions) callback(message as never) }
async function openWithTask() {
  const mounted = render(<App />)
  await waitFor(() => expect(held).toHaveLength(1))
  await act(async () => held[0].resolve(reply(init("A", { active_task: task() }))))
  await waitFor(() => expect(latest.activeTask?.id).toBe("task-A"))
  return mounted
}
async function terminalPoll() {
  await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/tasks/task-A?"))).toBe(true), { timeout: 5000 })
  const poll = held.find((request) => request.path.startsWith("/api/tasks/task-A?"))!
  await act(async () => poll.resolve(reply(task("completed"))))
  await waitFor(() => expect(held.some((request) => request.path.includes("/A/messages"))).toBe(true))
  await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/artifacts"))).toBe(true))
  return { messages: held.find((request) => request.path.includes("/A/messages"))!, artifacts: held.find((request) => request.path.startsWith("/api/artifacts"))! }
}
function reply(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }) }
function init(id = "A", extra = {}) { return { conversation: conversation(id), messages: [message(`m${id}`, id)], artifacts: id === "A" ? [artifact] : [], active_task: null, task_messages: [], has_more_messages: false, has_more_conversations: false, has_more_artifacts: false, flagged_message_ids: [], cache_valid: false, message_count: 1, ...extra } }
function Probe({ target = "A", channel = "general", scrollTask = null }: { target?: string | null; channel?: string; scrollTask?: string | null }) {
  const currentOwner = useWorkspaceOwner(); React.useLayoutEffect(() => { liveOwner = currentOwner })
  const current = useAgentChat({ agentId: "agent", targetConvId: target, scrollToTaskId: scrollTask, scrollToMessageId: null, workspaceId: "workspace", agents: [], activeChannel: channel, readActiveChannel: () => channel, channelLoading: false, subscribeWs, subscribeReconnect, refreshInboxCount: vi.fn() }, external)
  React.useLayoutEffect(() => { latest = current })
  return <><div data-testid="messages">{current.messages.map((row) => row.content).join("|")}</div><div data-testid="cards">{current.artifacts.map((row) => row.filename).join("|")}</div><div data-testid="type">{current.conversation?.type}</div><div data-testid="thread">{current.conversation?.parent_message_id}:{current.conversation?.thread_title}:{current.conversation?.message_count}</div><div data-testid="naps">{current.napMarkers.map((row) => row.id).join("|")}</div><div data-testid="loading">{String(current.messagesLoading)}</div></>
}
function sendAndSettle(): Promise<void> {
  latest.handleSend()
  return waitFor(() => expect(liveOwner.queryClient.isMutating({ mutationKey: liveOwner.key("chat", "send") })).toBe(0))
}
let strictSendStarted = false
function StrictSendProbe(props: { target?: string | null; channel?: string }) {
  const child = Probe(props)
  const started = React.useRef(false)
  React.useEffect(() => { if (!started.current) { started.current = true; external.inputRef.current = "Strict send"; latest.handleSend(); strictSendStarted = true } }, [])
  return child
}
function App(props: { target?: string | null; channel?: string; strictSend?: boolean; hidden?: boolean; scrollTask?: string | null; sharedIssue?: boolean }) { return <ApplicationQueryProvider userId={mocks.user}><WorkspaceProvider workspaceId="workspace" slug="workspace"><React.Activity mode={props.hidden ? "hidden" : "visible"}>{props.strictSend ? <React.StrictMode><StrictSendProbe {...props} /></React.StrictMode> : <Probe {...props} />}</React.Activity>{props.sharedIssue && <SharedIssueConsumer />}</WorkspaceProvider></ApplicationQueryProvider> }
async function seed(extraConversation: Partial<Conversation> = {}) {
  const owner = createWorkspaceOwner(createApplicationOwner(mocks.user), "workspace", "workspace")
  await mergeCachedMessages("A", [message()], false, owner, 1)
  owner.queryClient.setQueryData<ChatExtras>(chatExtrasKey(owner, "A"), { conversation: conversation("A", extraConversation), artifacts: [artifact], hasMoreArtifacts: false })
  await setLastOpenConversation("agent", "general", { conversation_id: "A", newestMessageId: "mA", serverMessageCount: 1 }, owner)
  const persister = createIdbPersister(mocks.user, "application")
  await persistQueryClientSave({ queryClient: owner.queryClient, persister, buster: `${PERSIST_BUSTER}-application`, dehydrateOptions: { shouldDehydrateQuery: (query) => shouldPersistApplicationQuery(query.queryKey) } })
  owner.queryClient.clear()
}
beforeEach(async () => {
  await clearAllPersistedCaches()
  external.inputRef.current = ""; external.pendingFilesRef.current = [];
  mocks.user = "chat-user"; mocks.error.mockClear(); held = []; subscriptions.clear()
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
    if (path.includes("/skills")) return Promise.resolve(reply({ skills: [] }))
    if (path.includes("/threads")) return Promise.resolve(reply({ thread_summaries: [] }))
    if (path.includes("/api/inbox/")) return Promise.resolve(reply(null))
    return new Promise<Response>((resolve) => held.push({ path, body: options.body, method: options.method, resolve, signal: options.signal ?? undefined }))
  }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollTo = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); liveOwner?.queryClient.clear()
  })
})

describe("real chat hook canonical facts and qualified native restore", () => {
  it("restores messages and cards/type while background init remains held", async () => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(screen.getByTestId("messages").textContent).toBe("Message mA")
    expect(screen.getByTestId("cards").textContent).toBe("report.pdf")
    expect(screen.getByTestId("type").textContent).toBe("email_event")
    expect(screen.getByTestId("loading").textContent).toBe("false")
    await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(liveOwner.queryClient.getQueryCache().findAll({ queryKey: liveOwner.key("chat", "open") }).every((query) => query.state.fetchStatus === "idle")).toBe(true))
    expect(latest.messages).toHaveLength(1)
    act(() => mounted.unmount())
  })

  it.each(["A", null])("preserves complete thread fields target=%s after the canonical extras write", async (target) => {
    await seed({ parent_message_id: "root", thread_title: "Thread title", message_count: 4 })
    const mounted = render(<App target={target} />)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(screen.getByTestId("thread").textContent).toBe("root:Thread title:4")
    let initIndex = 0
    if (target === null) {
      await act(async () => held[0].resolve(reply({ conversation_id: "A", newest_message_id: "mA", message_count: 1 })))
      await waitFor(() => expect(held).toHaveLength(2))
      initIndex = 1
    }
    await act(async () => held[initIndex].resolve(reply(init("A", { conversation: conversation("A", { parent_message_id: "root", thread_title: "Thread title", message_count: 4 }) }))))
    await waitFor(() => expect(liveOwner.queryClient.getQueryCache().findAll({ queryKey: liveOwner.key("chat", "open") }).every((query) => query.state.fetchStatus === "idle")).toBe(true))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    expect(screen.getByTestId("thread").textContent).toBe("root:Thread title:4")
    act(() => mounted.unmount())
  })

  it("keeps messages and timeline references stable for UI-only repaint, then updates actual message content", async () => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    const messages = latest.messages, timeline = latest.timeline
    act(() => mounted.rerender(<App />))
    expect(latest.messages).toBe(messages)
    expect(latest.timeline).toBe(timeline)
    await act(async () => { await mergeCachedMessages("A", [message("mA", "A", { content: "Changed" })], null, liveOwner) })
    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe("Changed"))
    expect(latest.messages).not.toBe(messages)
    expect(latest.timeline).not.toBe(timeline)
    act(() => mounted.unmount())
  })

  it.each([false, true])("known conv channel replay while completed=%s stays populated and recovers cancelled work", async (completed) => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    if (completed) {
      await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
      await waitFor(() => expect(liveOwner.queryClient.getQueryCache().findAll({ queryKey: liveOwner.key("chat", "open") }).every((query) => query.state.fetchStatus === "idle")).toBe(true))
    }
    act(() => mounted.rerender(<App channel="other" />))
    if (completed) expect(held).toHaveLength(1)
    else {
      await waitFor(() => expect(held).toHaveLength(2))
      expect(held[0].signal?.aborted).toBe(true)
      await act(async () => held[1].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    }
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    expect(screen.getByTestId("messages").textContent).toBe("Message mA")
    act(() => mounted.unmount())
  })

  it("old explicit conv leaves latest-created pointer intact before reopening default", async () => {
    await seed()
    const mounted = render(<App target="OLD" />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("OLD"))))
    await waitFor(() => expect(latest.conversation?.id).toBe("OLD"))
    expect((await getLastOpenConversation("agent", "general", liveOwner))?.conversation_id).toBe("A")
    act(() => mounted.rerender(<App target={null} />))
    await waitFor(() => expect(held.some((request) => request.path.includes("check-fresh"))).toBe(true))
    expect(screen.getByTestId("messages").textContent).toBe("Message mA")
    expect(screen.getByTestId("cards").textContent).toBe("report.pdf")
    const fresh = held.find((request) => request.path.includes("check-fresh"))!
    await act(async () => fresh.resolve(reply({ conversation_id: "A", newest_message_id: "mA", message_count: 1 })))
    await waitFor(() => expect(held.filter((request) => request.path.includes("/A/init"))).toHaveLength(1))
    act(() => mounted.unmount())
  })

  it("cross-conversation frontier B keeps A complete, and single-conv entry does not fetch B", async () => {
    const mounted = render(<App target={null} />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply({ conversation_id: "A", newest_message_id: "mA", message_count: 12 })))
    await waitFor(() => expect(held).toHaveLength(2))
    await act(async () => held[1].resolve(reply(init("A", { messages: Array.from({ length: 12 }, (_, i) => message(`a${i}`)), has_more_conversations: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    let loading!: Promise<void>
    act(() => { loading = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(3))
    await act(async () => held[2].resolve(reply({ conversations: [{ id: "B", created_at: "2026-09-01T00:00:00Z" }], has_more: false })))
    await waitFor(() => expect(held).toHaveLength(4))
    await act(async () => { held[3].resolve(reply({ messages: [message("b1", "B", { created_at: "2026-09-01T00:00:00Z" })], has_more: true })); await loading })
    expect((await getCacheMeta("A", liveOwner))?.hasMore).toBe(false)
    expect((await getCacheMeta("B", liveOwner))?.hasMore).toBe(true)
    expect(latest.messages.map((row) => row.conversation_id)).toContain("B")
    expect(screen.getByTestId("naps").textContent).toContain("nap-B")
    act(() => mounted.rerender(<App target="A" />))
    await waitFor(() => expect(held).toHaveLength(5))
    await act(async () => held[4].resolve(reply(init("A", { cache_valid: true, messages: null, has_more_conversations: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    expect(latest.messages.every((row) => row.conversation_id === "A")).toBe(true)
    const count = held.length
    await act(async () => latest.loadOlderMessages())
    expect(held).toHaveLength(count)
    act(() => mounted.unmount())
  })
  it("held pagination owns its lock across repeated calls and consumes one previous cursor", async () => {
    const mounted = render(<App target={null} />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply({ conversation_id: "A", newest_message_id: "a11", message_count: 12 })))
    await waitFor(() => expect(held).toHaveLength(2))
    await act(async () => held[1].resolve(reply(init("A", { messages: Array.from({ length: 12 }, (_, i) => message(`a${i}`)), has_more_conversations: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    let first!: Promise<void>, third!: Promise<void>
    act(() => { first = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(3))
    await act(async () => latest.loadOlderMessages())
    act(() => { third = latest.loadOlderMessages() })
    await act(async () => held[2].resolve(reply({ conversations: [{ id: "B", created_at: "2026-09-01T00:00:00Z" }, { id: "C", created_at: "2026-08-01T00:00:00Z" }], has_more: false })))
    await waitFor(() => expect(held).toHaveLength(4))
    await act(async () => { held[3].resolve(reply({ messages: Array.from({ length: 20 }, (_, i) => message(`b${i}`, "B", { created_at: "2026-09-01T00:00:00Z" })), has_more: false })); await Promise.all([first, third]) })
    expect(latest.previousConversations.map((row) => row.id)).toEqual(["C"])
    expect(latest.messages).toHaveLength(32)
    expect(latest.napMarkers.map((row) => row.id)).toEqual(["nap-B"])
    expect(held.filter((request) => request.path.includes("/B/messages"))).toHaveLength(1)
    expect(held.some((request) => request.path.includes("/C/messages"))).toBe(false)
    expect(latest.loadingMore).toBe(false)
    act(() => mounted.unmount())
  })

  it("native paging retains a WS message, page cursors and history through a two-page refetch with another WS between pages", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { artifacts: [], has_more_messages: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    let loading!: Promise<void>
    act(() => { loading = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(2))
    const live = message("live-1", "A", { created_at: "2026-10-01T12:01:00Z" })
    act(() => ws({ type: "conversation.message", conversationId: "A", message: live }))
    const older = message("older", "A", { created_at: "2026-10-01T11:00:00Z" })
    await act(async () => { held[1].resolve(reply({ messages: [older], has_more: false })); await loading })
    const key = chatMessagesKey(liveOwner, "A")
    expect(liveOwner.queryClient.getQueryData<ChatMessagesData>(key)?.pages).toHaveLength(2)
    expect(liveOwner.queryClient.getQueryData<ChatMessagesData>(key)?.pageParams).toHaveLength(2)
    expect(latest.messages.map((row) => row.id)).toEqual(["older", "mA", "live-1"])
    act(() => ws({ type: "task.created", conversationId: "A", task: task() }))
    await waitFor(() => expect(held).toHaveLength(3))
    await act(async () => held[2].resolve(reply({ messages: [message(), live], has_more: true })))
    await waitFor(() => expect(held).toHaveLength(4))
    const between = message("live-between", "A", { created_at: "2026-10-01T12:02:00Z" })
    act(() => ws({ type: "conversation.message", conversationId: "A", message: between }))
    await act(async () => held[3].resolve(reply({ messages: [older], has_more: false })))
    await waitFor(() => expect(liveOwner.queryClient.getQueryState(key)?.fetchStatus).toBe("idle"))
    expect(latest.messages.map((row) => row.id)).toEqual(["older", "mA", "live-1", "live-between"])
    const data = liveOwner.queryClient.getQueryData<ChatMessagesData>(key)!
    expect(data.pages).toHaveLength(2)
    expect(data.pageParams).toHaveLength(2)
    expect(data.pages.at(-1)?.hasMore).toBe(false)
    act(() => mounted.unmount())
  })

  it("a terminal poll with messages complete and artifacts held cannot publish or continue after target retirement", async () => {
    const mounted = await openWithTask()
    const requests = await terminalPoll()
    await act(async () => requests.messages.resolve(reply({ messages: [message("completed-message")], has_more: false })))
    await waitFor(() => expect(liveOwner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(liveOwner, "A"))?.pages.flatMap((page) => page.messages).some((row) => row.id === "completed-message")).toBe(true))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(held.some((request) => request.path.includes("/B/init"))).toBe(true))
    const next = held.find((request) => request.path.includes("/B/init"))!
    await act(async () => next.resolve(reply(init("B"))))
    await waitFor(() => expect(latest.conversation?.id).toBe("B"))
    const count = held.length
    await act(async () => requests.artifacts.resolve(reply([artifact])))
    await waitFor(() => expect(liveOwner.queryClient.getQueryState(chatExtrasKey(liveOwner, "A"))?.fetchStatus).toBe("idle"))
    expect(latest.activeTask).toBeNull()
    expect(latest.artifacts).toEqual([])
    expect(mocks.error).not.toHaveBeenCalled()
    expect(held).toHaveLength(count)
    act(() => mounted.unmount())
  })

  it("current terminal message failure retains completed task and the ordinary refresh error", async () => {
    const mounted = await openWithTask()
    const requests = await terminalPoll()
    await act(async () => requests.artifacts.resolve(reply([artifact])))
    await act(async () => requests.messages.resolve(reply({ error: "failed" }, 500)))
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Failed to refresh messages"))
    expect(latest.activeTask?.status).toBe("completed")
    expect(latest.artifacts).toEqual([artifact])
    expect(held.filter((request) => request.path.startsWith("/api/tasks/task-A?"))).toHaveLength(1)
    act(() => mounted.unmount())
  })

  it("drops malformed restored messages/cards and heals through current online init", async () => {
    const owner = createWorkspaceOwner(createApplicationOwner(mocks.user), "workspace", "workspace")
    await mergeCachedMessages("A", [message()], false, owner, 1)
    owner.queryClient.setQueryData<ChatMessagesData>(chatMessagesKey(owner, "A"), (data) => ({ ...data!, pages: [{ messages: [{ ...message(), attachment_ids: [123] as never }], hasMore: false }] }))
    owner.queryClient.setQueryData(chatExtrasKey(owner, "A"), { conversation: conversation(), artifacts: [{ id: "broken", conversation_id: "A", filename: "bad.pdf", content_type: "application/pdf" }], hasMoreArtifacts: false })
    await persistQueryClientSave({ queryClient: owner.queryClient, persister: createIdbPersister(mocks.user, "application"), buster: `${PERSIST_BUSTER}-application`, dehydrateOptions: { shouldDehydrateQuery: (query) => shouldPersistApplicationQuery(query.queryKey) } })
    owner.queryClient.clear()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(latest.messages).toEqual([])
    expect(latest.artifacts).toEqual([])
    expect(held[0].path).not.toContain("newest_message_id")
    await act(async () => held[0].resolve(reply(init())))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    expect(latest.messages.map((row) => row.id)).toEqual(["mA"])
    expect(latest.artifacts).toEqual([artifact])
    act(() => mounted.unmount())
  })

  it("warm B keeps forty canonical rows but A's five-message remainder selects only five and retains local older availability", async () => {
    const mounted = render(<App target={null} />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply({ conversation_id: "A", newest_message_id: "a11", message_count: 12 })))
    await waitFor(() => expect(held).toHaveLength(2))
    const aRows = Array.from({ length: 12 }, (_, i) => message(`a${i}`))
    await act(async () => held[1].resolve(reply(init("A", { messages: aRows, has_more_messages: true, has_more_conversations: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    const bRows = Array.from({ length: 40 }, (_, i) => message(`b${i}`, "B", { created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }))
    const bKey = chatMessagesKey(liveOwner, "B")
    act(() => liveOwner.queryClient.setQueryData<ChatMessagesData>(bKey, { pages: [{ messages: bRows.slice(20), hasMore: true }, { messages: bRows.slice(0, 20), hasMore: false }], pageParams: [null, { limit: 20, before: bRows[20].created_at, beforeId: bRows[20].id }], serverMessageCount: 40 }))
    let loading!: Promise<void>
    act(() => { loading = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(3))
    const olderA = Array.from({ length: 15 }, (_, i) => message(`old-a${i}`, "A", { created_at: new Date(Date.UTC(2026, 9, 1, 11, i)).toISOString() }))
    await act(async () => held[2].resolve(reply({ messages: olderA, has_more: false })))
    await waitFor(() => expect(held).toHaveLength(4))
    await act(async () => held[3].resolve(reply({ conversations: [{ id: "B", created_at: "2026-09-01T00:00:00Z" }], has_more: false })))
    await waitFor(() => expect(held).toHaveLength(5))
    await act(async () => held[4].resolve(reply({ messages: bRows.slice(20), has_more: true })))
    await waitFor(() => expect(held).toHaveLength(6))
    await act(async () => { held[5].resolve(reply({ messages: bRows.slice(0, 20), has_more: false })); await loading })
    expect(latest.messages.filter((row) => row.conversation_id === "B").map((row) => row.id)).toEqual(["b35", "b36", "b37", "b38", "b39"])
    expect(liveOwner.queryClient.getQueryData<ChatMessagesData>(bKey)?.pages.flatMap((page) => page.messages)).toHaveLength(40)
    expect((await getCacheMeta("B", liveOwner))?.hasMore).toBe(false)
    expect(latest.hasMore).toBe(true)
    const count = held.length
    await act(async () => latest.loadOlderMessages())
    expect(held).toHaveLength(count)
    expect(latest.messages.filter((row) => row.conversation_id === "B")).toHaveLength(25)
    expect((await getCacheMeta("B", liveOwner))?.hasMore).toBe(false)
    act(() => mounted.unmount())
  })

  it.each(["A", null])("actual AgentChatView target=%s hides Reply in thread while cache is warm and renders the qualified parent root", async (target) => {
    await seed({ parent_message_id: "root", thread_title: "Thread title", message_count: 4 })
    const mounted = render(<ApplicationQueryProvider userId={mocks.user}><WorkspaceProvider workspaceId="workspace" slug="workspace"><AgentChatView agentId="agent" targetConvId={target} /></WorkspaceProvider></ApplicationQueryProvider>)
    await waitFor(() => expect(screen.getByTestId("view-mA")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Reply in thread" })).toBeNull()
    expect(screen.getByTestId("view-mA").getAttribute("data-conversation-type")).toBe("email_event")
    if (target === null) {
      const fresh = held.find((request) => request.path.includes("check-fresh"))!
      await act(async () => fresh.resolve(reply({ conversation_id: "A", newest_message_id: "mA", message_count: 1 })))
    }
    await waitFor(() => expect(held.some((request) => request.path.includes("/A/init"))).toBe(true))
    const initRequest = held.find((request) => request.path.includes("/A/init"))!
    const root = message("root", "parent", { role: "user", content: "Parent root" })
    await act(async () => initRequest.resolve(reply(init("A", { conversation: conversation("A", { parent_message_id: "root", thread_title: "Thread title", message_count: 4 }), root_message: root }))))
    await waitFor(() => expect(screen.getByTestId("view-root").getAttribute("data-thread-root")).toBe("true"))
    expect(screen.getByTestId("view-root").textContent).toBe("Parent root")
    expect(screen.queryByRole("button", { name: "Reply in thread" })).toBeNull()
    expect(held.filter((request) => request.path.includes("/A/init"))).toHaveLength(1)
    act(() => mounted.unmount())
  })

  it.each([false, true])("actual Strict replay rejects the retired mutation before API dispatch; multipart=%s", async (multipart) => {
    strictSendStarted = false
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    const assign = vi.fn(), actualWindow = window
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    if (multipart) external.pendingFilesRef.current = [{ file: new File(["file"], "file.txt"), thumbnailUrl: null, thumbnailBlob: null }] as never
    act(() => mounted.rerender(<App strictSend />))
    await waitFor(() => expect(strictSendStarted).toBe(true))
    await waitFor(() => expect(liveOwner.queryClient.isMutating({ mutationKey: liveOwner.key("chat", "send") })).toBe(0))
    expect(held.some((request) => request.path.includes("/A/messages") && request.method === "POST")).toBe(false)
    const currentInit = held.filter((request) => request.path.includes("/A/init")).at(-1)!
    await act(async () => currentInit.resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    expect(assign).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(latest.failedSends.size).toBe(0)
    expect(latest.sending).toBe(false)
    act(() => mounted.unmount())
  })

  it.each([false, true])("current send 401 clears its original account before the real sign-in transition; multipart=%s", async (multipart) => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    const assign = vi.fn(), actualWindow = window
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    external.inputRef.current = "Current send"
    if (multipart) external.pendingFilesRef.current = [{ file: new File(["file"], "file.txt"), thumbnailUrl: null, thumbnailBlob: null }] as never
    let sent!: Promise<void>
    act(() => { sent = sendAndSettle() })
    await waitFor(() => expect(held).toHaveLength(2))
    expect(held[1].body instanceof FormData).toBe(multipart)
    await act(async () => { held[1].resolve(reply({}, 401)); await sent })
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    expect(String(assign.mock.calls[0][0])).toBe("https://alook.test/sign-in")
    expect(liveOwner.application.lifecycle.get().active).toBe(false)
    expect(liveOwner.queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(screen.queryByTestId("messages")).toBeNull()
    act(() => mounted.unmount())
  })

  it("unselected scroll task native read cancels when its only actual chat view retires", async () => {
    const mounted = render(<App scrollTask="task-A" />);
    await waitFor(() => expect(held).toHaveLength(1)); await act(async () => held[0].resolve(reply(init())));
    await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/tasks/task-A?"))).toBe(true));
    const read = held.find((request) => request.path.startsWith("/api/tasks/task-A?"))!;
    const assign = vi.fn(), real = window; vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }));
    act(() => mounted.rerender(<App scrollTask="task-A" hidden />)); expect(read.signal?.aborted).toBe(true);
    await act(async () => read.resolve(reply({}, 401))); expect(assign).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled(); expect(liveOwner.queryClient.getQueryData(liveOwner.key("chat", "task", "task-A"))).toBeUndefined();
  });
  it.each([false, true])("held command read shares with a real issue task consumer, releaseAll=%s", async (releaseAll) => {
    const mounted = render(<App scrollTask="task-A" />);
    await waitFor(() => expect(held).toHaveLength(1)); await act(async () => held[0].resolve(reply(init())));
    await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/tasks/task-A?"))).toBe(true));
    const read = held.find((request) => request.path.startsWith("/api/tasks/task-A?"))!;
    act(() => mounted.rerender(<App scrollTask="task-A" sharedIssue />)); await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/issues/issue?"))).toBe(true));
    const issueRead = held.find((request) => request.path.startsWith("/api/issues/issue?"))!;
    await act(async () => issueRead.resolve(reply({ issue: { id: "issue", latest_task_id: "task-A", conversation_id: "A", trace_id: null }, messages: [], comments: [], artifacts: [] })));
    await waitFor(() => expect(sharedSheet.issueDetail?.issue.id).toBe("issue"));
    const assign = vi.fn(), real = window; vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }));
    act(() => mounted.rerender(<App scrollTask="task-A" hidden sharedIssue={!releaseAll} />)); expect(read.signal?.aborted).toBe(releaseAll);
    await act(async () => read.resolve(reply(releaseAll ? {} : task("completed"), releaseAll ? 401 : 200)));
    if (!releaseAll) await waitFor(() => expect(sharedSheet.issueActiveTask?.status).toBe("completed"));
    expect(held.filter((request) => request.path.startsWith("/api/tasks/task-A?"))).toHaveLength(1); expect(assign).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled(); expect(held.some((request) => request.path.includes("/task-A/messages"))).toBe(false);
  });

  it.each([200, 500, 401])("old previous-page response %s cannot run its fallback after the next target is active", async (status) => {
    const mounted = render(<App target={null} />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply({ conversation_id: "A", newest_message_id: "a11", message_count: 12 })))
    await waitFor(() => expect(held).toHaveLength(2))
    await act(async () => held[1].resolve(reply(init("A", { messages: Array.from({ length: 12 }, (_, i) => message(`a${i}`)), has_more_conversations: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    let paging!: Promise<void>
    act(() => { paging = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(3))
    const old = held[2]
    const assign = vi.fn(), actualWindow = window
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(held).toHaveLength(4))
    await act(async () => held[3].resolve(reply(init("B", { has_more_conversations: true }))))
    await waitFor(() => expect(latest.conversation?.id).toBe("B"))
    await act(async () => { old.resolve(reply(status === 200 ? { conversations: [{ id: "OLD", created_at: "2026-09-01T00:00:00Z" }], has_more: false } : { error: "failed" }, status)); await paging })
    expect(assign).not.toHaveBeenCalled()
    expect(latest.hasMoreConversations).toBe(true)
    expect(latest.previousConversations).toEqual([])
    expect(latest.messages.every((row) => row.conversation_id === "B")).toBe(true)
    expect(mocks.error).not.toHaveBeenCalled()
    act(() => mounted.unmount())
  })

  it.each([false, true])("held send 401 cannot escape after Activity retires/reactivates the same view; multipart=%s", async (multipart) => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    const assign = vi.fn(), actualWindow = window
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    external.inputRef.current = "Held send"
    if (multipart) external.pendingFilesRef.current = [{ file: new File(["file"], "file.txt"), thumbnailUrl: null, thumbnailBlob: null }] as never
    let sent!: Promise<void>
    act(() => { sent = sendAndSettle() })
    await waitFor(() => expect(held).toHaveLength(2))
    const originalView = latest.chatView, originalGeneration = originalView.get().generation
    act(() => mounted.rerender(<App hidden />))
    act(() => mounted.rerender(<App />))
    expect(latest.chatView).toBe(originalView)
    expect(latest.chatView.get().generation).toBeGreaterThan(originalGeneration)
    await waitFor(() => expect(held).toHaveLength(3))
    await act(async () => held[2].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    await act(async () => { held[1].resolve(reply({}, 401)); await sent })
    expect(assign).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(latest.failedSends.size).toBe(0)
    expect(latest.sending).toBe(false)
    act(() => mounted.unmount())
  })

  it.each([200, 401])("send succeeded but held artifact status=%s cannot publish or navigate after switching targets", async (status) => {
    await seed()
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { cache_valid: true, messages: null }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    const assign = vi.fn(), actualWindow = window
    vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }))
    external.inputRef.current = "Send with file"
    let sent!: Promise<void>
    act(() => { sent = sendAndSettle() })
    await waitFor(() => expect(held).toHaveLength(2))
    await act(async () => { held[1].resolve(reply({ message: message("sent", "A", { role: "user", attachment_ids: [artifact.id] }), task: task() })); await sent })
    await waitFor(() => expect(held.some((request) => request.path.startsWith("/api/artifacts"))).toBe(true))
    const old = held.find((request) => request.path.startsWith("/api/artifacts"))!
    act(() => mounted.rerender(<App target="B" />))
    await waitFor(() => expect(held.some((request) => request.path.includes("/B/init"))).toBe(true))
    const next = held.find((request) => request.path.includes("/B/init"))!
    await act(async () => next.resolve(reply(init("B"))))
    await waitFor(() => expect(latest.conversation?.id).toBe("B"))
    const count = held.length
    await act(async () => old.resolve(reply(status === 200 ? [artifact] : {}, status)))
    await waitFor(() => expect(liveOwner.queryClient.getQueryState(chatExtrasKey(liveOwner, "A"))?.fetchStatus).toBe("idle"))
    expect(latest.artifacts).toEqual([])
    expect(latest.activeTask).toBeNull()
    expect(assign).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(held).toHaveLength(count)
    act(() => mounted.unmount())
  })

  it("native cancellation of a current paging request is quiet and preserves the previous cursor", async () => {
    const mounted = render(<App />)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0].resolve(reply(init("A", { has_more_messages: true }))))
    await waitFor(() => expect(latest.messagesLoading).toBe(false))
    let paging!: Promise<void>
    act(() => { paging = latest.loadOlderMessages() })
    await waitFor(() => expect(held).toHaveLength(2))
    await act(async () => { await liveOwner.queryClient.cancelQueries({ queryKey: chatMessagesKey(liveOwner, "A"), exact: true }); await paging })
    expect(held[1].signal?.aborted).toBe(true)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(latest.hasMore).toBe(true)
    expect(latest.loadingMore).toBe(false)
    await act(async () => held[1].resolve(reply({ messages: [message("cancelled-page")], has_more: false })))
    expect(latest.messages.map((row) => row.id)).toEqual(["mA"])
    act(() => mounted.unmount())
  })

})
