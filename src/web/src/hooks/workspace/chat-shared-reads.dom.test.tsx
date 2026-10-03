import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import { useQuery, useInfiniteQuery } from "@tanstack/react-query"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { ApplicationQueryProvider } from "@/lib/application-owner"
import { WorkspaceProvider, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { chatReadSource, chatTaskOptions, chatArtifactOptions, chatTaskMessagesOptions, chatActiveTaskOptions, chatFlagsOptions, chatMessagePageOptions } from "./chat-query-options"
import { useChatData } from "./use-chat-data"
import { workspaceIssueOptions } from "./issue-query-options"
import { useChatSheets } from "../use-chat-sheets"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "shared-user" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
const error = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { error } }))
let owner: WorkspaceOwner
let held: Array<{ resolve: (response: Response) => void; signal: AbortSignal }>
const observed: Record<string, unknown> = {}
const sheetViews: Record<string, ReturnType<typeof useChatSheets>> = {}
const subscribe = () => () => {}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
function App({ children }: { children: React.ReactNode }) { return <ApplicationQueryProvider userId="shared-user"><WorkspaceProvider workspaceId="workspace" slug="workspace">{children}</WorkspaceProvider></ApplicationQueryProvider> }
function Resource({ name, factory }: { name: string; factory: (source: ReturnType<typeof chatReadSource>) => ReturnType<typeof chatTaskOptions> }) {
  const currentOwner = useWorkspaceOwner(); useLayoutEffect(() => { owner = currentOwner }); const chat = useChatData(currentOwner, name, "conv"); const source = chatReadSource(currentOwner, chat.view, name);
  const data = useQuery(factory(source)).data; useLayoutEffect(() => { observed[name] = data }); return null
}
function Messages({ name }: { name: string }) { const currentOwner = useWorkspaceOwner(); useLayoutEffect(() => { owner = currentOwner }); const chat = useChatData(currentOwner, name, "conv"); const data = useInfiniteQuery(chatMessagePageOptions(chatReadSource(currentOwner, chat.view, name), "conv")).data; useLayoutEffect(() => { observed[name] = data }); return null }
function Issues({ name }: { name: string }) { const currentOwner = useWorkspaceOwner(); useLayoutEffect(() => { owner = currentOwner }); const chat = useChatData(currentOwner, name, "conv"); const value = useChatSheets(currentOwner, chat.view); useLayoutEffect(() => { sheetViews[name] = value }); return null }
beforeEach(async () => { await clearAllPersistedCaches(); held = []; error.mockClear(); for (const key of Object.keys(observed)) delete observed[key]; vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => new Promise<Response>((resolve) => held.push({ resolve, signal: options.signal as AbortSignal })))) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); owner?.queryClient.clear()
  })
})
const cases = [
  ["task", (source: ReturnType<typeof chatReadSource>) => chatTaskOptions(source, "task"), { id: "task", status: "running" }],
  ["artifacts", (source: ReturnType<typeof chatReadSource>) => chatArtifactOptions(source, "conv"), []],
  ["task messages", (source: ReturnType<typeof chatReadSource>) => chatTaskMessagesOptions(source, "task"), []],
  ["active task", (source: ReturnType<typeof chatReadSource>) => chatActiveTaskOptions(source, "conv"), { id: "task", status: "running" }],
  ["flags", (source: ReturnType<typeof chatReadSource>) => chatFlagsOptions(source, "conv"), { message_ids: ["message"] }],
] as const

describe("native shared fact read lifetime", () => {
  it.each(cases)("%s keeps the one held read after its initiating chat view retires", async (_name, factory, data) => {
    const sameFactory = factory as unknown as (source: ReturnType<typeof chatReadSource>) => ReturnType<typeof chatTaskOptions>
    const contents = (first: boolean) => <App>{first && <Resource name="A" factory={sameFactory} />}<Resource name="B" factory={sameFactory} /></App>
    const mounted = render(contents(true)); await waitFor(() => expect(held).toHaveLength(1));
    act(() => mounted.rerender(contents(false))); expect(held[0].signal.aborted).toBe(false);
    await act(async () => held[0].resolve(response(data))); await waitFor(() => expect(observed.B).toBeDefined());
    expect(held).toHaveLength(1); expect(error).not.toHaveBeenCalled()
  })
  it("messages preserve their aggregate for a second actual infinite observer", async () => {
    const contents = (first: boolean) => <App>{first && <Messages name="A" />}<Messages name="B" /></App>
    const mounted = render(contents(true)); await waitFor(() => expect(held).toHaveLength(1)); act(() => mounted.rerender(contents(false)));
    await act(async () => held[0].resolve(response({ messages: [{ id: "message", conversation_id: "conv", role: "user", content: "shared", created_at: "2026-10-01T00:00:00Z", attachment_ids: null, task_id: null }], has_more: false })));
    await waitFor(() => expect(observed.B).toMatchObject({ pages: [{ messages: [{ id: "message" }] }] })); expect(held).toHaveLength(1)
  })
  it("task query cancellation when all actual observers retire suppresses late 401", async () => {
    const factory = (source: ReturnType<typeof chatReadSource>) => chatTaskOptions(source, "task")
    const contents = (visible: boolean) => <App>{visible && <><Resource name="A" factory={factory} /><Resource name="B" factory={factory} /></>}</App>
    const mounted = render(contents(true)); await waitFor(() => expect(held).toHaveLength(1));
    const real = window, assign = vi.fn(); vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) } }));
    act(() => mounted.rerender(contents(false))); expect(held[0].signal.aborted).toBe(true);
    await act(async () => held[0].resolve(response({}, 401))); expect(assign).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
  })
  it("two real issue selections deduplicate and keep B after A retires", async () => {
    const contents = (first: boolean) => <App>{first && <Issues name="A" />}<Issues name="B" /></App>
    const mounted = render(contents(true)); await waitFor(() => expect(sheetViews.B).toBeDefined());
    act(() => { void sheetViews.A.openIssue("issue"); void sheetViews.B.openIssue("issue") }); await waitFor(() => expect(held).toHaveLength(1));
    act(() => mounted.rerender(contents(false)));
    const detail = { issue: { id: "issue", title: "shared issue", conversation_id: null, latest_task_id: null, trace_id: null }, messages: [], comments: [], artifacts: [] };
    await act(async () => held[0].resolve(response(detail))); await waitFor(() => expect(sheetViews.B.issueDetail?.issue.title).toBe("shared issue")); expect(held).toHaveLength(1); expect(error).not.toHaveBeenCalled(); expect(owner.queryClient.getQueryData(workspaceIssueOptions(owner, "issue").queryKey)).toMatchObject(detail)
  })
})
