import React, { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { AgentRuntime, Email, WsMessage } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { ApplicationOwnerProvider, createApplicationOwner, retireApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { WorkspaceProvider, captureWorkspaceOwner, useWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import type { WhitelistEntry } from "@/lib/api"
import { emailBodyOptions, emailEntityKey, emailListOptions, emailThreadOptions, useEmailRows } from "./email-query-options"
import { workspaceFileOptions } from "./file-query-options"
import { useAgentPermissionCommand, usePendingAgentPermissions } from "./use-agent-permission-command"
import { usePendingRuntimeCommands, useRuntimeCommand } from "./use-runtime-command"

type Held = { path: string; method: string; body: string | undefined; signal: AbortSignal | undefined; resolve: (response: Response) => void }
type FileReceipt = Extract<WsMessage, { type: "workspace.files" }>
let application: ApplicationOwner
let owner: WorkspaceOwner
let held: Held[]
let permission: ReturnType<typeof useAgentPermissionCommand>
let runtimeCommand: ReturnType<typeof useRuntimeCommand>
let pendingPermissions: ReturnType<typeof usePendingAgentPermissions>
let pendingRuntimes: ReturnType<typeof usePendingRuntimeCommands>
const listeners = new Set<(message: WsMessage) => void>()
const subscribe = (callback: (message: WsMessage) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } }
const emit = (message: FileReceipt) => { for (const listener of listeners) listener(message) }
const json = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const email = (id = "mail", subject = "Original", html_body = "<p>Original body</p>"): Email => ({ id, subject, html_body, agent_id: "agent", from_email: "from@example.test", to_email: "to@example.test", r2_key: `mail/${id}`, is_whitelisted: true, forwarded: false, message_id: id, in_reply_to: "", references: "", attachments: [], status: "received", direction: "inbound", created_at: "2026-10-01T00:00:00Z" })
const runtime = (): AgentRuntime => ({ id: "runtime", workspace_id: "workspace", daemon_id: null, runtime_mode: "local", provider: "codex", status: "online", device_info: "device", metadata: {}, pending_update_version: null, pending_rescan: false, last_seen_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" })
function Capture({ children }: { children: React.ReactNode }) {
  const current = useWorkspaceOwner()
  useLayoutEffect(() => { owner = current })
  return children
}
function App({ children = null, workspace = "workspace" }: { children?: React.ReactNode; workspace?: string }) {
  return <ApplicationOwnerProvider owner={application}><QueryClientProvider client={application.queryClient}><WorkspaceProvider workspaceId={workspace} slug={workspace}><Capture>{children}</Capture></WorkspaceProvider></QueryClientProvider></ApplicationOwnerProvider>
}
function EmailWindow({ thread = false }: { thread?: boolean }) {
  const current = useWorkspaceOwner()
  const window = useQuery(thread ? emailThreadOptions(current, "mail") : emailListOptions(current, "agent", "inbox"))
  const rows = useEmailRows(current, window.data?.ids ?? [])
  return <output data-testid="emails">{rows.map((row) => `${row.id}:${row.subject}`).join("|")}</output>
}
function Body() {
  const current = useWorkspaceOwner()
  const body = useQuery(emailBodyOptions(current, "mail"))
  return <output data-testid="body">{body.data?.content ?? "pending"}</output>
}
function File({ name = "file", mode = "read" }: { name?: string; mode?: "tree" | "read" }) {
  const current = useWorkspaceOwner()
  const result = useQuery(workspaceFileOptions(current, "agent", "runtime", mode, "/file.txt", subscribe))
  return <output data-testid={name}>{result.data?.content ?? result.status}</output>
}
function Permissions() {
  const current = useWorkspaceOwner()
  const command = useAgentPermissionCommand(current, "agent")
  const pending = usePendingAgentPermissions(current, "agent")
  useLayoutEffect(() => { permission = command; pendingPermissions = pending })
  return <output data-testid="permission-pending">{pending.map((action) => action.kind).join(",")}</output>
}
function Runtimes() {
  const current = useWorkspaceOwner()
  const command = useRuntimeCommand(current)
  const pending = usePendingRuntimeCommands(current)
  useLayoutEffect(() => { runtimeCommand = command; pendingRuntimes = pending })
  return <output data-testid="runtime-pending">{pending.map((action) => action.kind).join(",")}</output>
}
beforeEach(() => {
  held = []
  listeners.clear()
  localStorage.clear()
  application = createApplicationOwner("resource-user", new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }))
  vi.stubGlobal("fetch", vi.fn((path: RequestInfo | URL, options: RequestInit = {}) => new Promise<Response>((resolve) => held.push({ path: String(path), method: options.method ?? "GET", body: options.body as string | undefined, signal: options.signal ?? undefined, resolve }))))
  return async () => { retireApplicationOwner(application); await application.queryClient.cancelQueries(); application.queryClient.clear(); vi.unstubAllGlobals(); listeners.clear() }
})

describe("actual native workspace resource boundaries", () => {
  it.each([false, true])("publishes an ID-only email window with canonical entity/body readers (%s)", async (thread) => {
    const view = render(<App><EmailWindow thread={thread} /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(new URL(held[0]!.path, "https://alook.test").searchParams.get("workspace_id")).toBe("workspace")
    if (thread) expect(held[0]!.path).toContain("/mail/thread")
    await act(async () => held[0]!.resolve(json([email()])))
    await waitFor(() => expect(view.getByTestId("emails").textContent).toBe("mail:Original"))
    const options = thread ? emailThreadOptions(owner, "mail") : emailListOptions(owner, "agent", "inbox")
    expect(owner.queryClient.getQueryData(options.queryKey)).toEqual({ ids: ["mail"] })
    expect(owner.queryClient.getQueryData<Email>(emailEntityKey(owner, "mail"))?.html_body).toBe("")
    expect(owner.queryClient.getQueryData(emailBodyOptions(owner, "mail").queryKey)).toEqual({ content: "<p>Original body</p>", isHtml: true })
    act(() => owner.queryClient.setQueryData(emailEntityKey(owner, "mail"), email("mail", "Live canonical", "")))
    await waitFor(() => expect(view.getByTestId("emails").textContent).toBe("mail:Live canonical"))
    expect(held).toHaveLength(1)
  })

  it("does not overwrite newer entity or body writes with a held email window", async () => {
    const view = render(<App />)
    act(() => {
      owner.queryClient.setQueryData(emailEntityKey(owner, "mail"), email("mail", "Baseline", ""))
      owner.queryClient.setQueryData(emailBodyOptions(owner, "mail").queryKey, { content: "Baseline body", isHtml: false })
      view.rerender(<App><EmailWindow /></App>)
    })
    await waitFor(() => expect(held).toHaveLength(1))
    act(() => {
      owner.queryClient.setQueryData(emailEntityKey(owner, "mail"), email("mail", "Newer canonical", ""))
      owner.queryClient.setQueryData(emailBodyOptions(owner, "mail").queryKey, { content: "Newer body", isHtml: false })
    })
    await act(async () => held[0]!.resolve(json([email("mail", "Held old", "<p>Held old body</p>")])))
    await waitFor(() => expect(view.getByTestId("emails").textContent).toBe("mail:Newer canonical"))
    expect(owner.queryClient.getQueryData(emailBodyOptions(owner, "mail").queryKey)).toEqual({ content: "Newer body", isHtml: false })
  })

  it("a newer body survives even when the held list can seed its unchanged entity", async () => {
    const view = render(<App />)
    act(() => {
      owner.queryClient.setQueryData(emailEntityKey(owner, "mail"), email("mail", "Baseline", ""))
      owner.queryClient.setQueryData(emailBodyOptions(owner, "mail").queryKey, { content: "Baseline body", isHtml: false })
      view.rerender(<App><EmailWindow /></App>)
    })
    await waitFor(() => expect(held).toHaveLength(1))
    act(() => owner.queryClient.setQueryData(emailBodyOptions(owner, "mail").queryKey, { content: "Newer body", isHtml: false }))
    await act(async () => held[0]!.resolve(json([email("mail", "Fresh header", "<p>Old body</p>")])))
    await waitFor(() => expect(view.getByTestId("emails").textContent).toBe("mail:Fresh header"))
    expect(owner.queryClient.getQueryData(emailBodyOptions(owner, "mail").queryKey)).toEqual({ content: "Newer body", isHtml: false })
  })

  it("shares a body request and aborts only its last observer before a late401", async () => {
    const view = render(<App><Body /><Body /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    view.rerender(<App><Body /></App>)
    expect(held[0]!.signal?.aborted).toBe(false)
    const assign = vi.fn(), originalWindow = window
    vi.stubGlobal("window", new Proxy(originalWindow, { get: (target, key) => key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) }))
    view.rerender(<App />)
    expect(held[0]!.signal?.aborted).toBe(true)
    await act(async () => held[0]!.resolve(json({}, 401)))
    expect(assign).not.toHaveBeenCalled()
    expect(application.lifecycle.get().active).toBe(true)
  })

  it("renders a real HTML body response through its native Query", async () => {
    const view = render(<App><Body /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    await act(async () => held[0]!.resolve(new Response("<p>Downloaded body</p>", { headers: { "Content-Type": "text/html" } })))
    await waitFor(() => expect(view.getByTestId("body").textContent).toBe("<p>Downloaded body</p>"))
    expect(owner.queryClient.getQueryData(emailBodyOptions(owner, "mail").queryKey)).toEqual({ content: "<p>Downloaded body</p>", isHtml: true })
  })

  it.each(["tree", "read"] as const)("matches an early file WS receipt to the actual HTTP request ID (%s)", async (mode) => {
    const view = render(<App><File mode={mode} /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(JSON.parse(held[0]!.body!)).toEqual({ request_type: mode, path: "/file.txt" })
    const receipt: FileReceipt = { type: "workspace.files", agentId: "agent", requestId: "accepted", requestType: mode, result: { path: "/file.txt", content: "Matching file" } }
    act(() => { emit({ ...receipt, agentId: "other", result: { path: "/file.txt", content: "Wrong agent" } }); emit({ ...receipt, requestId: "foreign", result: { path: "/file.txt", content: "Wrong request" } }); emit(receipt) })
    expect(view.getByTestId("file").textContent).toBe("pending")
    await act(async () => held[0]!.resolve(json({ request_id: "accepted" })))
    await waitFor(() => expect(view.getByTestId("file").textContent).toBe("Matching file"))
    expect(listeners.size).toBe(0)
  })

  it("retains a shared file read until its last observer then aborts HTTP and unsubscribes WS", async () => {
    const view = render(<App><File name="first" /><File name="second" /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    expect(listeners.size).toBe(1)
    view.rerender(<App><File name="first" /></App>)
    expect(held[0]!.signal?.aborted).toBe(false)
    expect(listeners.size).toBe(1)
    view.rerender(<App />)
    expect(held[0]!.signal?.aborted).toBe(true)
    expect(listeners.size).toBe(0)
    await act(async () => held[0]!.resolve(json({ request_id: "late" })))
    expect(owner.queryClient.getQueryData(workspaceFileOptions(owner, "agent", "runtime", "read", "/file.txt", subscribe).queryKey)).toBeUndefined()
  })

  it("serializes whitelist actions while native pending includes the queued command", async () => {
    const view = render(<App><Permissions /></App>)
    act(() => owner.queryClient.setQueryData(owner.key("agent-whitelist", "agent"), []))
    act(() => {
      permission.mutate({ action: { kind: "whitelist-add", email: "new@example.test" }, token: captureWorkspaceOwner(owner) })
      permission.mutate({ action: { kind: "whitelist-remove", id: "new-entry" }, token: captureWorkspaceOwner(owner) })
    })
    await waitFor(() => expect(pendingPermissions).toHaveLength(2))
    expect(view.getByTestId("permission-pending").textContent).toBe("whitelist-add,whitelist-remove")
    await waitFor(() => expect(held).toHaveLength(1))
    expect(held[0]!.method).toBe("POST")
    expect(JSON.parse(held[0]!.body!)).toEqual({ email: "new@example.test" })
    const row: WhitelistEntry = { id: "new-entry", email: "new@example.test", created_at: "2026-10-01T00:00:00Z" }
    await act(async () => held[0]!.resolve(json(row)))
    await waitFor(() => expect(held).toHaveLength(2))
    expect(owner.queryClient.getQueryData(owner.key("agent-whitelist", "agent"))).toEqual([row])
    expect(held[1]!.method).toBe("DELETE")
    expect(held[1]!.path).toContain("/whitelist/new-entry?")
    await act(async () => held[1]!.resolve(json(undefined, 204)))
    await waitFor(() => expect(pendingPermissions).toEqual([]))
    expect(owner.queryClient.getQueryData(owner.key("agent-whitelist", "agent"))).toEqual([])
  })

  it("does not replace newer permission facts or resurrect a replacement resource", async () => {
    render(<App><Permissions /></App>)
    const key = owner.key("agent-whitelist", "agent")
    const row: WhitelistEntry = { id: "live", email: "live@example.test", created_at: "2026-10-01T00:00:00Z" }
    act(() => owner.queryClient.setQueryData(key, []))
    act(() => permission.mutate({ action: { kind: "whitelist-add", email: "old@example.test" }, token: captureWorkspaceOwner(owner) }))
    await waitFor(() => expect(held).toHaveLength(1))
    act(() => { owner.queryClient.removeQueries({ queryKey: key, exact: true }); owner.queryClient.setQueryData(key, [row]) })
    const replacement = owner.queryClient.getQueryCache().find({ queryKey: key, exact: true })!
    await act(async () => held[0]!.resolve(json({ ...row, id: "old", email: "old@example.test" })))
    await waitFor(() => expect(pendingPermissions).toEqual([]))
    expect(owner.queryClient.getQueryData(key)).toEqual([row])
    expect(replacement.state.isInvalidated).toBe(false)
  })

  it("serializes runtime update/rescan and preserves a newer live pending value", async () => {
    render(<App><Runtimes /></App>)
    const key = owner.key("runtimes")
    act(() => owner.queryClient.setQueryData(key, [runtime()]))
    act(() => {
      runtimeCommand.mutate({ kind: "update", id: "runtime", token: captureWorkspaceOwner(owner) })
      runtimeCommand.mutate({ kind: "rescan", id: "runtime", token: captureWorkspaceOwner(owner) })
    })
    await waitFor(() => expect(pendingRuntimes).toHaveLength(2))
    await waitFor(() => expect(held).toHaveLength(1))
    expect(held[0]!.path).toContain("/runtime/update?")
    act(() => owner.queryClient.setQueryData(key, [{ ...runtime(), pending_update_version: "newer-live" }]))
    await act(async () => held[0]!.resolve(json({ pending_update_version: "held-old" })))
    await waitFor(() => expect(held).toHaveLength(2))
    expect(owner.queryClient.getQueryData<AgentRuntime[]>(key)?.[0]?.pending_update_version).toBe("newer-live")
    expect(held[1]!.path).toContain("/runtime/rescan?")
    await act(async () => held[1]!.resolve(json({ pending_rescan: true })))
    await waitFor(() => expect(pendingRuntimes).toEqual([]))
    expect(owner.queryClient.getQueryData<AgentRuntime[]>(key)?.[0]).toMatchObject({ pending_update_version: "newer-live", pending_rescan: true })
  })

  it.each(["permission", "runtime"] as const)("physically aborts a retired %s view and suppresses its late401 auth/UI effects", async (kind) => {
    const view = render(<App>{kind === "permission" ? <Permissions /> : <Runtimes />}</App>)
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
    act(() => {
      if (kind === "permission") {
        owner.queryClient.setQueryData(owner.key("agent-whitelist", "agent"), [])
        permission.mutate({ action: { kind: "whitelist-add", email: "old@example.test" }, token: captureWorkspaceOwner(owner) }, callbacks)
      } else {
        owner.queryClient.setQueryData(owner.key("runtimes"), [runtime()])
        runtimeCommand.mutate({ kind: "update", id: "runtime", token: captureWorkspaceOwner(owner) }, callbacks)
      }
    })
    await waitFor(() => expect(held).toHaveLength(1))
    const original = owner, assign = vi.fn(), originalWindow = window
    vi.stubGlobal("window", new Proxy(originalWindow, { get: (target, key) => key === "location" ? { origin: "https://alook.test", assign } : Reflect.get(target, key, target) }))
    view.rerender(<App />)
    expect(held[0]!.signal?.aborted).toBe(true)
    await act(async () => held[0]!.resolve(json({}, 401)))
    await waitFor(() => expect(original.queryClient.isMutating()).toBe(0))
    expect(assign).not.toHaveBeenCalled()
    expect(callbacks.onSuccess).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSettled).not.toHaveBeenCalled()
    expect(application.lifecycle.get().active).toBe(true)
  })

  it("workspace replacement cancels its original query without authorizing a late response on reentry", async () => {
    const view = render(<App><Body /></App>)
    await waitFor(() => expect(held).toHaveLength(1))
    const original = owner
    view.rerender(<App workspace="other" />)
    expect(original.lifecycle.get().active).toBe(false)
    expect(held[0]!.signal?.aborted).toBe(true)
    view.rerender(<App />)
    expect(owner).not.toBe(original)
    await act(async () => held[0]!.resolve(new Response("old body")))
    expect(owner.queryClient.getQueryData(emailBodyOptions(owner, "mail").queryKey)).toBeUndefined()
  })
})
