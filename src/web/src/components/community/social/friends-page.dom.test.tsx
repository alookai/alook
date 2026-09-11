import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FriendsPage } from "./friends-page"
import { tid } from "@/lib/community/testids"

const mocks = vi.hoisted(() => ({ tabs: vi.fn() }))

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

beforeEach(() => mocks.tabs.mockClear())

function renderPage(page: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>,
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
    const onAccept = vi.fn(() => new Promise<void>((next) => { resolve = next }))
    const onOpenProfile = vi.fn()
    const renderer = renderPage(<FriendsPage
      friends={[]}
      pending={pending}
      blocked={[]}
      activeTab="new"
      onAccept={onAccept}
      onOpenProfile={onOpenProfile}
    />)
    const open = renderer.getByText("Ada").closest("button")!
    const accept = renderer.getByRole("button", { name: "Accept Ada's friend request" })
    expect(open.contains(accept)).toBe(false)
    fireEvent.click(open)
    expect(onOpenProfile).toHaveBeenCalledWith("Ada", expect.anything(), undefined, "u1")
    onOpenProfile.mockClear()

    fireEvent.click(accept)
    expect(onAccept).toHaveBeenCalledWith("fr_1")
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
