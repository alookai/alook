import "fake-indexeddb/auto"
import { StrictMode, createContext, useContext } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { InviteAcceptClient } from "./invite-accept-client"

type Identity = { data: { user: { id: string } } | null; isPending: boolean; error: Error | null }
const pending: Identity = { data: null, isPending: true, error: null }
const guest: Identity = { data: null, isPending: false, error: null }
const known = (id: string): Identity => ({ data: { user: { id } }, isPending: false, error: null })
const identityInput = createContext<Identity>(pending)
let viewer: string | null | undefined
const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn(), autojoin: false }))

vi.mock("@/lib/auth-client", () => ({ useSession: () => useContext(identityInput), currentSessionViewer: () => viewer }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => new URLSearchParams(mocks.autojoin ? "autojoin=1" : "") }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: vi.fn(async () => undefined) }))
vi.mock("@/lib/observability/regions", () => ({ useObservedRegion: vi.fn() }))

type Post = { path: string; signal: AbortSignal; response: Promise<Response>; complete: (value: Response) => void }
let posts: Post[]
let mounted: ReturnType<typeof render> | undefined
let token: string
let strict: boolean

function current(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
}
function failure(status: number) {
  return current({ contractVersion: BUSINESS_SCHEMA_VERSION, error: { code: "invalid_input", message: "Join failed", retryable: false } }, status)
}
function tree(identity: Identity) {
  viewer = identity.isPending || identity.error ? undefined : identity.data?.user.id ?? null
  const content = <identityInput.Provider value={identity}><InviteAcceptClient token={token} /></identityInput.Provider>
  return strict ? <StrictMode>{content}</StrictMode> : content
}
function mount(identity: Identity) {
  mounted = render(tree(identity))
}
async function transition(identity: Identity) {
  await act(async () => mounted!.rerender(tree(identity)))
}
async function preview() {
  await screen.findByRole("heading", { name: "Example server" })
  return screen.getByRole("button", { name: "Join server" })
}
async function clickJoin() {
  const button = await preview()
  await act(async () => { fireEvent.click(button) })
}
async function complete(post: Post, response = current({ serverId: "joined-server" })) {
  await act(async () => { post.complete(response); await post.response })
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.autojoin = false
  token = "invite"
  strict = false
  posts = []
  await act(async () => { await clearAllPersistedCaches() })
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input)
    if (path.endsWith("/info")) return Promise.resolve(current({ serverId: "server", serverName: "Example server", serverIcon: null, serverDescription: "Preview before identity", memberCount: 1, memberPreview: [], inviter: null }))
    if (path.endsWith("/join")) {
      const signal = options?.signal
      if (!signal || options?.method !== "POST") throw new Error("Join must carry its original view signal")
      let resolve!: (value: Response) => void
      const response = new Promise<Response>(done => { resolve = done })
      posts.push({ path, signal, response, complete: resolve })
      return response
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
})
afterEach(async () => {
  await act(async () => {
    mounted?.unmount()
    mounted = undefined
    for (const post of posts) post.complete(current({ serverId: "cleanup" }))
    await Promise.all(posts.map(post => post.response))
  })
  await vi.dynamicImportSettled()
  vi.unstubAllGlobals()
})

describe("real public invitation identity boundary", () => {
  it("cold manual Join waits for confirmation instead of aborting an early write", async () => {
    mount(pending)
    await preview()
    expect(screen.getByText("Preview before identity")).toBeVisible()
    await clickJoin()
    const premature = posts.slice()
    await transition(known("A"))
    const button = await preview()
    await waitFor(() => expect(button).toBeEnabled())
    expect(premature.map(post => ({ aborted: post.signal.aborted }))).toEqual([])
    await clickJoin()
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.signal.aborted).toBe(false)
    await complete(posts[0]!)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/joined-server"))
  })

  it.each(["pending", "error"])("shows the preview but admits neither manual nor automatic Join for initial %s", async state => {
    mocks.autojoin = true
    mount(state === "pending" ? pending : { ...pending, isPending: false, error: new Error("offline") })
    const button = await preview()
    expect(button).toBeDisabled()
    await act(async () => { fireEvent.click(button) })
    expect(posts).toHaveLength(0)
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("waits to consume autojoin, then retains it across account keys and rerenders", async () => {
    mocks.autojoin = true
    mount(pending)
    await preview()
    expect(posts).toHaveLength(0)
    await transition(known("A"))
    await waitFor(() => expect(posts).toHaveLength(1))
    const original = posts[0]!
    await transition(known("A"))
    expect(posts).toHaveLength(1)
    await transition(known("B"))
    const button = await preview()
    expect(original.signal.aborted).toBe(true)
    expect(button).toBeEnabled()
    expect(posts).toHaveLength(1)
    await complete(original)
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    await clickJoin()
    await waitFor(() => expect(posts).toHaveLength(2))
    await complete(posts[1]!, current({ serverId: "new-account-server" }))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/new-account-server"))
  })

  it("does not cancel an admitted A Join during a temporary unknown session", async () => {
    mount(known("A"))
    await clickJoin()
    await waitFor(() => expect(posts).toHaveLength(1))
    const original = posts[0]!
    await transition(pending)
    expect(original.signal.aborted).toBe(false)
    await transition(known("A"))
    expect(original.signal.aborted).toBe(false)
    expect(posts).toHaveLength(1)
    await complete(original)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/joined-server"))
  })

  it("does not automatically resend a dispatched Join after an active failure", async () => {
    mocks.autojoin = true
    mount(known("A"))
    await waitFor(() => expect(posts).toHaveLength(1))
    await complete(posts[0]!, failure(500))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Join failed"))
    await transition(known("A"))
    await preview()
    expect(posts).toHaveLength(1)
    await transition(known("B"))
    await preview()
    expect(posts).toHaveLength(1)
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it.each([
    { next: "B", result: "success" },
    { next: "guest", result: "401" },
    { next: "B", result: "error" },
  ])("cancels A and suppresses late $result after replacement by $next", async ({ next, result }) => {
    mount(known("A"))
    await clickJoin()
    await waitFor(() => expect(posts).toHaveLength(1))
    const original = posts[0]!
    await transition(next === "guest" ? guest : known(next))
    await preview()
    expect(original.signal.aborted).toBe(true)
    await complete(original, result === "success" ? current({ serverId: "stale-A" }) : failure(result === "401" ? 401 : 500))
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
  })

  it("keeps guest401 sign-in return and a new confirmed autojoin landing", async () => {
    mount(guest)
    await clickJoin()
    await waitFor(() => expect(posts).toHaveLength(1))
    await complete(posts[0]!, failure(401))
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/sign-in?redirect=%2Fc%2Finvite%2Finvite%3Fautojoin%3D1"))
    await act(async () => { mounted!.unmount(); mounted = undefined })
    mocks.autojoin = true
    mount(pending)
    await preview()
    expect(posts).toHaveLength(1)
    await transition(known("A"))
    await waitFor(() => expect(posts).toHaveLength(2))
    await transition(known("A"))
    expect(posts).toHaveLength(2)
    await complete(posts[1]!)
    await waitFor(() => expect(mocks.push).toHaveBeenLastCalledWith("/c/channels/joined-server"))
    expect(mocks.push).toHaveBeenCalledTimes(2)
  })

  it("gives a different invitation token its own intent while retiring the old view", async () => {
    mocks.autojoin = true
    mount(known("A"))
    await waitFor(() => expect(posts).toHaveLength(1))
    token = "another-invite"
    await transition(known("A"))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[0]!.signal.aborted).toBe(true)
    expect(posts[1]!.path).toBe("/api/community/invites/another-invite/join")
    await complete(posts[0]!)
    expect(mocks.push).not.toHaveBeenCalled()
    await complete(posts[1]!)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/joined-server"))
  })

  it("autojoin uses the live view once in the actual Strict Mode provider composition", async () => {
    mocks.autojoin = true
    strict = true
    mount(known("A"))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.signal.aborted).toBe(false)
    await transition(known("A"))
    expect(posts).toHaveLength(1)
    await complete(posts[0]!)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/joined-server"))
  })
})
