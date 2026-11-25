import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { serverResourceFixture } from "@/test/community-resource-fixtures"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { ServerRefPill } from "./server-ref-pill"

const m = vi.hoisted(() => ({ navigate: vi.fn(), api: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: m.api }))
vi.mock("@/stores/community", () => ({
  useUiHandlers: () => ({ navigate: m.navigate }),
}))

beforeEach(() => {
  vi.resetAllMocks()
})

describe("ServerRefPill direct community-db resolution", () => {
  it("renders immediately from community-db servers when zero channels are cached and emits zero HTTP requests", () => {
    const client = new QueryClient()
    client.setQueryData(communityKeys.communityDbCollection("viewer", "servers"), [
      serverResourceFixture({ id: "srv_alook", name: "Alook", discriminator: "5620", ownerId: "viewer" }),
    ])
    client.setQueryData(communityKeys.communityDbCollection("viewer", "channels"), [])

    render(
      React.createElement(
        CommunityTestProvider,
        { client },
        React.createElement(ServerRefPill, null, "/Alook#5620"),
      ),
    )

    const button = screen.getByRole("button", { name: "Alook" })
    expect(button).toBeTruthy()
    expect(m.api).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(m.navigate).toHaveBeenCalledExactlyOnceWith("srv_alook")
  })

  it("updates label live on WS server rename and falls back to plain text on server revocation", async () => {
    const client = new QueryClient()
    client.setQueryData(communityKeys.communityDbCollection("viewer", "servers"), [
      serverResourceFixture({ id: "srv_alook", name: "Alook", discriminator: "5620", ownerId: "viewer" }),
    ])

    render(
      React.createElement(
        CommunityTestProvider,
        { client },
        React.createElement(ServerRefPill, null, "/Alook#5620"),
      ),
    )

    expect(screen.getByRole("button", { name: "Alook" })).toBeTruthy()
    const registry = getCommunityDbRegistry(client)!
    await act(async () => {
      projectCommunityWsEventToDb(client, {
        type: "community:server.update",
        serverId: "srv_alook",
        changes: { name: "Alook" },
      })
      registry.runtime.ws.actions.revokeServerAccess("srv_alook")
    })

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("/Alook#5620")).toBeTruthy()
  })
})
