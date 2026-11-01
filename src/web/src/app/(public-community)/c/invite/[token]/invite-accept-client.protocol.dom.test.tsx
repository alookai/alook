import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { ApplicationOwnerProvider, createApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { InviteAcceptClient } from "./invite-accept-client"

const mocks = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn(), update: vi.fn(), autojoin: false }))
let owner: ApplicationOwner
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => new URLSearchParams(mocks.autojoin ? "autojoin=1" : "") }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: vi.fn(async () => undefined) }))
vi.mock("@/lib/observability/regions", () => ({ useObservedRegion: vi.fn() }))
vi.mock("@/lib/business-schema-lifecycle", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/business-schema-lifecycle")>()
  mocks.update.mockImplementation((expected = BUSINESS_SCHEMA_VERSION) => new actual.BusinessSchemaMismatch(expected))
  return { ...actual, requestBusinessSchemaUpdate: mocks.update }
})
vi.mock("@/lib/application-owner", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/application-owner")>(),
  PublicQueryProvider: ({ children }: { children: React.ReactNode }) => <ApplicationOwnerProvider owner={owner}><QueryClientProvider client={owner.queryClient}>{children}</QueryClientProvider></ApplicationOwnerProvider>,
}))

function current(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
}
function info() {
  return current({ serverId: "s1", serverName: "Example", serverIcon: null, serverDescription: "", memberCount: 0, memberPreview: [], inviter: null })
}
function error(message: string, status: number) {
  return current({ contractVersion: BUSINESS_SCHEMA_VERSION, error: { code: status === 401 ? "unauthenticated" : "invalid_input", message, retryable: false } }, status)
}
async function join() {
  fireEvent.click(await screen.findByRole("button", { name: "Join server" }))
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.autojoin = false
  owner = createApplicationOwner("visitor", new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }))
})
afterEach(() => { owner.queryClient.clear(); vi.unstubAllGlobals() })

describe("actual public invite join caller", () => {
  it("sends the current contract, consumes the current navigation target and joins once", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(current({ serverId: "s1", member: { id: "current-operation-row" } }))
    vi.stubGlobal("fetch", fetchMock)
    render(<InviteAcceptClient token="invite" />)
    await join()
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/c/channels/s1"))
    expect(mocks.toast).toHaveBeenCalledWith("Joined server")
    const [path, options] = fetchMock.mock.calls[1]
    expect(path).toBe("/api/community/invites/invite/join")
    expect(options.method).toBe("POST")
    expect(new Headers(options.headers).get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it("keeps anonymous401 on the invite sign-in return path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(error("unauthorized", 401)))
    render(<InviteAcceptClient token="invite" />)
    await join()
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/sign-in?redirect=%2Fc%2Finvite%2Finvite%3Fautojoin%3D1"))
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled()
  })
  it("reads the current error message rather than an error object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(error("Already a member", 400)))
    render(<InviteAcceptClient token="invite" />)
    await join()
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Already a member"))
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
  })
  it("autojoin performs only one current operation", async () => {
    mocks.autojoin = true
    const fetchMock = vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(current({ serverId: "s1" }))
    vi.stubGlobal("fetch", fetchMock)
    const mounted = render(<InviteAcceptClient token="invite" />)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/c/channels/s1"))
    mounted.rerender(<InviteAcceptClient token="invite" />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/join"))).toHaveLength(1)
  })
  it.each(["bad-json", "bad-target"])("only an active %s body may request an update", async kind => {
    const bad = () => kind === "bad-json" ? new Response("{", { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } }) : current({ serverId: null })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(bad()))
    const mounted = render(<InviteAcceptClient token="invite" />)
    await join()
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    mounted.unmount(); mocks.update.mockClear(); mocks.toast.mockClear()
    let release!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(info()).mockReturnValueOnce(pending))
    const next = render(<InviteAcceptClient token="invite" />)
    await join()
    next.rerender(<output>New screen</output>)
    await act(async () => { release(bad()); await pending })
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled()
  })
  it("rejects a lower confirmation without consuming its target", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(Response.json({ serverId: "old" }, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION - 1) } })))
    render(<InviteAcceptClient token="invite" />)
    await join()
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(BUSINESS_SCHEMA_VERSION - 1))
    expect(mocks.push).not.toHaveBeenCalled()
  })
})
