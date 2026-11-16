import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { friendBucketScenarioFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { communityKeys } from "@/lib/query-keys"
import { friendsQueryFn } from "@/hooks/community/use-friends"
import MeFriendsPage from "./friends-route"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
vi.mock("@/contexts/community/module-route", () => ({
  useCommunityModuleLocation: () => ({ router: { push: vi.fn(), replace: vi.fn() }, searchParams: new URLSearchParams() }),
}))
vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

describe("Friends route cached display and first-read errors", () => {
  it.each(["rows", "known-empty", "unread"])("renders %s truthfully and keeps Retry on the unread failure", async mode => {
    const { client, registry } = await createCommunityQueryOwner()
    if (mode === "rows") {
      await writeCommunityCollectionRows(registry, "profiles", [profileResourceFixture({ id: "peer", name: "Cached peer" })], row => row.id)
      await writeCommunityCollectionRows(registry, "friendships", [{ id: "friend", userId: "peer", kind: "accepted" }], row => row.id)
    } else if (mode === "known-empty") client.setQueryData(communityKeys.friends(), { ids: [] })
    apiFetchMock.mockRejectedValue(new Error("Refresh unavailable"))
    const view = render(<CommunityTestProvider client={client} registry={registry} retainOwner><MeFriendsPage /></CommunityTestProvider>)
    await act(async () => { await client.query({ queryKey: communityKeys.friends(), queryFn: friendsQueryFn, staleTime: 0 }).catch(() => undefined) })
    await waitFor(() => expect(client.getQueryState(communityKeys.friends())?.status).toBe("error"))
    if (mode === "rows") {
      await waitFor(() => expect(view.getByText("Cached peer")).toBeVisible())
      expect(view.queryByText("Couldn't load friends")).toBeNull()
    } else if (mode === "known-empty") {
      await waitFor(() => expect(view.getByText("No friends yet. Add someone from the New tab.")).toBeVisible())
      expect(view.queryByText("Couldn't load friends")).toBeNull()
    } else {
      expect(view.getByRole("alert")).toHaveTextContent("Couldn't load friends")
      expect(view.queryByText("No friends yet. Add someone from the New tab.")).toBeNull()
      apiFetchMock.mockImplementation(async (url: string) => friendBucketScenarioFixture(url.endsWith("/accepted") ? "friends" : url.endsWith("/pending") ? "pending" : "blocked", []))
      fireEvent.click(view.getByRole("button", { name: "Retry" }))
      await waitFor(() => expect(view.getByText("No friends yet. Add someone from the New tab.")).toBeVisible())
      expect(client.getQueryState(communityKeys.friends())?.status).toBe("success")
    }
  })
})
