import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"

const backend = vi.hoisted(() => { const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); return fetch })
vi.mock("@/lib/analytics", () => ({
  trackCommunityWsAuthFailure: vi.fn(), trackCommunityWsFrameDropped: vi.fn(),
  trackCommunityWsLifecycleClose: vi.fn(), trackCommunityWsLifecycleRecovery: vi.fn(),
  trackCommunityWsLifecycleStage: vi.fn(), trackCommunityWsRetryScheduled: vi.fn(),
}))
import { authClient } from "./auth-client"
import { useUserWs } from "./use-user-ws"

class SessionSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: SessionSocket[] = []
  readyState = SessionSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { SessionSocket.instances.push(this) }
  send(value: string) { this.sent.push(value) }
  close(code = 1000, reason = "") {
    if (this.readyState === SessionSocket.CLOSED) return
    this.readyState = SessionSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true })
  }
  open() { this.readyState = SessionSocket.OPEN; this.onopen?.() }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  authenticate() { this.open(); this.message({ type: "auth.ok", communityContract: 2 }) }
  rejected() { this.readyState = SessionSocket.CLOSED; this.onclose?.({ code: 1008, reason: "Unauthorized", wasClean: false }) }
}

type SessionIdentity = { userId: string; id: string; token: string }
type HeldResponse = { response: Response; release: (response: Response) => void; signal: AbortSignal | null | undefined }
let selected: SessionIdentity | null
let sessionError: boolean
let holdTokens: boolean
let held: HeldResponse[]
let sessionRequests: number
let tokenPaths: string[]

function sessionPayload() {
  if (!selected) return null
  const now = new Date().toISOString()
  return {
    user: { id: selected.userId, name: selected.userId, email: selected.userId + "@example.test", emailVerified: true, image: null, createdAt: now, updatedAt: now },
    session: { id: selected.id, token: selected.token, userId: selected.userId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: now, updatedAt: now },
  }
}

beforeEach(async () => {
  selected = { userId: "account-a", id: "session-a-1", token: "fixture-sdk-a-1" }
  sessionError = false
  holdTokens = false
  held = []
  sessionRequests = 0
  tokenPaths = []
  SessionSocket.instances = []
  vi.stubGlobal("WebSocket", SessionSocket)
  vi.stubGlobal("fetch", backend)
  backend.mockReset()
  backend.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    if (url.pathname.endsWith("/get-session")) {
      sessionRequests++
      return sessionError ? Response.json({ message: "fixture session unavailable" }, { status: 500 }) : Response.json(sessionPayload())
    }
    if (url.pathname.endsWith("/sign-in/email")) return Response.json({ redirect: false, user: sessionPayload()!.user, token: selected!.token })
    if (url.pathname.endsWith("/sign-out")) { selected = null; return Response.json({ success: true }) }
    if (url.pathname === "/api/ws/token") {
      tokenPaths.push(url.pathname + url.search)
      const response = selected ? Response.json({ userId: selected.userId, token: "fixture-http-" + selected.id, wsPort: 9123 }) : new Response("Unauthorized", { status: 401 })
      if (!holdTokens) return response
      return new Promise<Response>(release => held.push({ response, release, signal: init?.signal }))
    }
    throw new Error("Unexpected native SDK fixture path " + url.pathname)
  })
  await act(async () => {
    await authClient.$store.atoms.session.get().refetch()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(authClient.$store.atoms.session.get()).toMatchObject({ isPending: false, error: null, data: { user: { id: "account-a" } } })
  expect(authClient.$store.atoms.session.get().data?.session.expiresAt).toBeInstanceOf(Date)
  return async () => {
    for (const value of held) value.release(value.response)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)) })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

function mount(onMessage = vi.fn()) {
  return renderHook(({ viewerUserId }) => useUserWs(onMessage, {
    viewerUserId, communityContract: 2, requestDaemonStatusOnAuth: false,
  }), { initialProps: { viewerUserId: "account-a" } })
}

async function authenticateInitial() {
  await waitFor(() => expect(SessionSocket.instances).toHaveLength(1))
  act(() => SessionSocket.instances[0]!.authenticate())
}

function authTokens(socket: SessionSocket) {
  return socket.sent.flatMap(value => {
    const message = JSON.parse(value) as { type?: string; token?: string }
    return message.type === "auth" ? [message.token] : []
  })
}

describe("real BetterAuth SDK WebSocket ownership", () => {
  it("uses the installed SDK parsed credential on reconnect while a bootstrap-only HTTP gate stays unused", async () => {
    const view = mount()
    await authenticateInitial()
    expect(tokenPaths).toEqual(["/api/ws/token"])
    holdTokens = true
    act(() => view.result.current.reconnectNow())
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(2))
    const replacement = SessionSocket.instances[1]!
    act(() => replacement.authenticate())
    expect(authTokens(replacement)).toEqual(["fixture-sdk-a-1"])
    expect(tokenPaths).toEqual(["/api/ws/token"])
    expect(held).toEqual([])
  })

  it("retires same-user session replacement through the public SDK sign-in lifecycle", async () => {
    const onMessage = vi.fn()
    mount(onMessage)
    await authenticateInitial()
    const original = SessionSocket.instances[0]!
    selected = { userId: "account-a", id: "session-a-2", token: "fixture-sdk-a-2" }
    await act(async () => { expect((await authClient.signIn.email({ email: "account-a@example.test", password: "fixture-only" })).error).toBeNull() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().data?.session.id).toBe("session-a-2"))
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(2))
    expect(original.readyState).toBe(SessionSocket.CLOSED)
    act(() => original.message({ type: "task.updated", taskId: "retired-a" }))
    expect(onMessage).not.toHaveBeenCalled()
    const replacement = SessionSocket.instances[1]!
    act(() => replacement.authenticate())
    expect(authTokens(replacement)).toEqual(["fixture-sdk-a-2"])
    expect(tokenPaths).toEqual(["/api/ws/token"])
  })

  it("retires a late old HTTP response during an SDK account switch and bootstraps the new owner separately", async () => {
    holdTokens = true
    const onMessage = vi.fn()
    const view = mount(onMessage)
    await waitFor(() => expect(held).toHaveLength(1))
    const original = held[0]!
    selected = { userId: "account-b", id: "session-b-1", token: "fixture-sdk-b-1" }
    await act(async () => { expect((await authClient.signIn.email({ email: "account-b@example.test", password: "fixture-only" })).error).toBeNull() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().data?.user.id).toBe("account-b"))
    expect(original.signal?.aborted).toBe(true)
    holdTokens = false
    await act(async () => { original.release(original.response) })
    expect(SessionSocket.instances).toEqual([])
    view.rerender({ viewerUserId: "account-b" })
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(1))
    const current = SessionSocket.instances[0]!
    expect(new URL(current.url).searchParams.get("userId")).toBe("account-b")
    act(() => { current.authenticate(); current.message({ type: "task.updated", taskId: "current-b" }) })
    expect(authTokens(current)).toEqual(["fixture-http-session-b-1"])
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage.mock.calls[0]![0]).toMatchObject({ taskId: "current-b" })
    expect(tokenPaths).toEqual(["/api/ws/token", "/api/ws/token"])
    await act(async () => { expect((await authClient.signOut()).error).toBeNull() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().data).toBeNull())
    expect(current.readyState).toBe(SessionSocket.CLOSED)
    const sent = current.sent.length
    act(() => { view.result.current.send({ type: "fixture-after-logout" }); current.message({ type: "task.updated", taskId: "retired-b" }) })
    expect(current.sent).toHaveLength(sent)
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it("uses HTTP instead of retained SDK error data and cancels that fallback when the real SDK session changes", async () => {
    const view = mount()
    await authenticateInitial()
    sessionError = true
    await act(async () => { await authClient.$store.atoms.session.get().refetch() })
    expect(authClient.$store.atoms.session.get().error).toBeTruthy()
    expect(authClient.$store.atoms.session.get().data?.session.token).toBe("fixture-sdk-a-1")
    holdTokens = true
    act(() => view.result.current.reconnectNow())
    await waitFor(() => expect(held).toHaveLength(1))
    const old = held[0]!
    sessionError = false
    selected = { userId: "account-a", id: "session-a-2", token: "fixture-sdk-a-2" }
    await act(async () => { expect((await authClient.signIn.email({ email: "account-a@example.test", password: "fixture-only" })).error).toBeNull() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().data?.session.id).toBe("session-a-2"))
    expect(old.signal?.aborted).toBe(true)
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(2))
    const current = SessionSocket.instances[1]!
    act(() => current.authenticate())
    await act(async () => { old.release(old.response) })
    expect(SessionSocket.instances).toHaveLength(2)
    expect(authTokens(current)).toEqual(["fixture-sdk-a-2"])
    expect(tokenPaths).toEqual(["/api/ws/token", "/api/ws/token"])
  })

  it("performs one authoritative fallback and one native SDK refetch without a rejected-credential event loop", async () => {
    const view = mount()
    await authenticateInitial()
    act(() => view.result.current.reconnectNow())
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(2))
    act(() => { SessionSocket.instances[1]!.open(); SessionSocket.instances[1]!.rejected() })
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(3), { timeout: 3_000 })
    expect(tokenPaths).toEqual(["/api/ws/token", "/api/ws/token?refresh=1"])
    sessionError = true
    const baseline = sessionRequests
    await act(async () => { SessionSocket.instances[2]!.open(); SessionSocket.instances[2]!.rejected() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().error).toBeTruthy())
    expect(sessionRequests).toBe(baseline + 1)
    act(() => {
      document.dispatchEvent(new Event("resume"))
      document.dispatchEvent(new Event("resume"))
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)) })
    expect(SessionSocket.instances).toHaveLength(3)
    expect(tokenPaths).toEqual(["/api/ws/token", "/api/ws/token?refresh=1"])
    expect(sessionRequests).toBe(baseline + 1)
  })

  it("preempts remote-close backoff when the public SDK replaces same-user A1 with A2", async () => {
    const view = mount()
    await authenticateInitial()
    act(() => view.result.current.reconnectNow())
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(2))
    const original = SessionSocket.instances[1]!
    act(() => original.authenticate())
    expect(authTokens(original)).toEqual(["fixture-sdk-a-1"])
    vi.spyOn(Math, "random").mockReturnValue(0.9)
    act(() => original.close(1006, "fixture remote outage"))
    selected = { userId: "account-a", id: "session-a-2", token: "fixture-sdk-a-2" }
    await act(async () => { expect((await authClient.signIn.email({ email: "account-a@example.test", password: "fixture-only" })).error).toBeNull() })
    await waitFor(() => expect(authClient.$store.atoms.session.get().data?.session.id).toBe("session-a-2"))
    await waitFor(() => expect(SessionSocket.instances).toHaveLength(3))
    const current = SessionSocket.instances[2]!
    act(() => current.authenticate())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)) })
    expect(original.readyState).toBe(SessionSocket.CLOSED)
    expect(SessionSocket.instances).toHaveLength(3)
    expect(authTokens(current)).toEqual(["fixture-sdk-a-2"])
    expect(tokenPaths).toEqual(["/api/ws/token"])
  })

  it("unsubscribes the installed SDK and fences old callbacks after a real React unmount", async () => {
    const onMessage = vi.fn()
    const view = mount(onMessage)
    await authenticateInitial()
    const old = SessionSocket.instances[0]!
    view.unmount()
    expect(old.readyState).toBe(SessionSocket.CLOSED)
    selected = { userId: "account-a", id: "session-a-2", token: "fixture-sdk-a-2" }
    await act(async () => { await authClient.$store.atoms.session.get().refetch() })
    act(() => { old.open(); old.message({ type: "auth.ok", communityContract: 2 }); old.message({ type: "task.updated", taskId: "after-unmount" }) })
    expect(onMessage).not.toHaveBeenCalled()
    expect(SessionSocket.instances).toHaveLength(1)
    expect(tokenPaths).toEqual(["/api/ws/token"])
  })
})
