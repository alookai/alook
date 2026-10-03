import React from "react"
import { QueryClient, useMutation } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FriendsPage } from "./friends-page"
import { tid } from "@/lib/community/testids"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { useFriendshipRows } from "@/lib/community-db/projections"
import { publishCommunityFriendships, publishCommunityFriendDecision, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

const mocks = vi.hoisted(() => ({ tabs: vi.fn(), toastError: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mocks.toastError(...args) } }))

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    mocks.tabs(props)
    return React.createElement("tabs-root", null, children)
  },
  TabsList: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-list", props, children),
  TabsTrigger: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-trigger", props, children),
  TabsContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-content", props, children),
}))

const pending = [
  { id: "fr_1", userId: "u1", name: "Ada", avatar: "A", avatarVersion: 1, kind: "incoming" as const, needsOwnerApproval: null },
  { id: "fr_gated", userId: "u2", name: "Bot", avatar: "B", avatarVersion: 1, kind: "incoming" as const, needsOwnerApproval: "owner" },
  { id: "fr_out", userId: "u3", name: "Grace", avatar: "G", avatarVersion: 1, kind: "outgoing" as const, needsOwnerApproval: null },
]

let pageClient: QueryClient
beforeEach(async () => { mocks.tabs.mockClear(); pageClient = (await createCommunityQueryOwner()).client })

function renderPage(page: React.ReactElement) {
  return render(
    <QueryClientProvider client={pageClient}>{page}</QueryClientProvider>,
  )
}

describe("FriendsPage actionable requests", () => {
  it("keeps the real Back control during a warm-data refresh", () => {
    const renderer = renderPage(<FriendsPage
      friends={[{
        id: "friend_1",
        userId: "user_1",
        name: "Alice",
        discriminator: "0001",
        avatar: "A",
        avatarVersion: 0,
        status: "online",
        sub: "",
      }]}
      pending={[]}
      blocked={[]}
      loading
      onBack={vi.fn()}
    />)

    expect(renderer.getByRole("button", { name: "Back" })).toBeInTheDocument()
  })

  it("uses the URL-owned tab and counts only actionable incoming rows", () => {
    const onActiveTabChange = vi.fn()
    const renderer = renderPage(<FriendsPage
      friends={[]}
      pending={pending}
      blocked={[]}
      activeTab="new"
      onActiveTabChange={onActiveTabChange}
    />)

    expect(mocks.tabs).toHaveBeenLastCalledWith(expect.objectContaining({ value: "new" }))
    const tabsProps = mocks.tabs.mock.calls.at(-1)?.[0] as { onValueChange: (value: string) => void }
    tabsProps.onValueChange("all")
    expect(onActiveTabChange).toHaveBeenCalledWith("all")
    expect(renderer.getByTestId(tid.friendsNewBadge)).toHaveTextContent("1")
    expect(renderer.getByText("Incoming — 1")).toBeInTheDocument()
  })

  it("keeps navigation and actions as siblings, and an action never navigates", async () => {
    let resolve!: () => void
    const onAccept = vi.fn((_id: string) => new Promise<void>((next) => { resolve = next }))
    const onOpenProfile = vi.fn()
    const { client, registry } = await createCommunityQueryOwner()
    publishCommunityFriendships(client, pending, { token: captureCommunityLiveSnapshotToken(client), signal: undefined })
    function NativeRequests() {
      const rows = useFriendshipRows()
      const command = useMutation({ mutationKey: ["community", "friend-request", "accept"], mutationFn: async ({ friendshipId }: { friendshipId: string }) => {
        const token = captureCommunityLiveSnapshotToken(client)
        await onAccept(friendshipId)
        publishCommunityFriendDecision(client, friendshipId, "accept", { token, signal: undefined })
      } })
      return <FriendsPage friends={[]} pending={pending.filter((request) => rows.some((row) => row.id === request.id && row.kind === request.kind))} blocked={[]} activeTab="new" onAccept={(friendshipId) => command.mutateAsync({ friendshipId })} onOpenProfile={onOpenProfile} />
    }
    const renderer = render(<QueryClientProvider client={client} registry={registry} retainOwner><NativeRequests /></QueryClientProvider>)
    const open = renderer.getByText("Ada").closest("button")!
    const accept = renderer.getByRole("button", { name: "Accept Ada's friend request" })
    expect(open.contains(accept)).toBe(false)
    fireEvent.click(open)
    expect(onOpenProfile).toHaveBeenCalledWith("Ada", expect.anything(), undefined, "u1")
    onOpenProfile.mockClear()

    fireEvent.click(accept)
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith("fr_1"))
    expect(onOpenProfile).not.toHaveBeenCalled()
    await waitFor(() => expect(accept).toBeDisabled())
    expect(open.closest("[aria-busy='true']")).not.toBeNull()

    resolve()
    await waitFor(() => expect(renderer.queryByRole(
      "button",
      { name: "Accept Ada's friend request" },
    )).toBeNull())
  })
})

describe("FriendsPage search owner", () => {
  it.each([false, true])("held search failure after retirement=%s only shows a current error", async (retired) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    let release!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { release = done }))
    mocks.toastError.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    const rendered = render(<QueryClientProvider client={queryClient}><FriendsPage friends={[]} pending={[]} blocked={[]} activeTab="new" /></QueryClientProvider>)
    try {
      fireEvent.change(rendered.getByPlaceholderText("Search by username"), { target: { value: "alice" } })
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      if (retired) registerCommunityDbRegistry(registry)()
      await act(async () => {
        release(new Response(JSON.stringify({ error: "Search unavailable" }), { status: 503 }))
      })
      await waitFor(() => expect(queryClient.getQueryState(["community", "user-search", "alice"])?.fetchStatus).toBe("idle"))
      if (retired) {
        expect(queryClient.getQueryState(["community", "user-search", "alice"])?.error).toMatchObject({ name: "AbortError" })
        expect(mocks.toastError).not.toHaveBeenCalled()
      } else await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Search unavailable"))
      expect(rendered.queryByText("alice#0001")).toBeNull()
    } finally { rendered.unmount(); vi.unstubAllGlobals() }
  })
})
