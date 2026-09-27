import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import {
  dehydrate,
  QueryClient,
  useQueryClient,
} from "@tanstack/react-query"
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER } from "@/lib/query-persister"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import {
  useCanonicalMessagesById,
  useDmProjection,
  useTrustedRestoredPrimary,
} from "@/lib/community-db/projections"

const persister = vi.hoisted(() => ({
  persistClient: vi.fn(() => Promise.resolve()),
  restoreClient: vi.fn(),
  removeClient: vi.fn(() => Promise.resolve()),
}))

vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/query-persister", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-persister")>()
  return {
    ...actual,
    createIdbPersister: vi.fn(() => persister as Persister),
  }
})

import { QueryProvider } from "./QueryProvider"

beforeEach(() => {
  persister.persistClient.mockClear()
  persister.restoreClient.mockReset()
  persister.removeClient.mockClear()
})

describe("QueryProvider persistence ordering", () => {
  it("hydrates canonical rows before collection preload can publish an empty snapshot", async () => {
    const viewerId = "restore-order-viewer"
    const message = {
      id: "persisted-message",
      channelId: "persisted-dm",
      type: "chat" as const,
      seq: 1,
      createdAt: "2026-09-25T00:00:00.000Z",
      content: "persisted canonical body",
    }
    const canonicalKey = communityKeys.communityDbCollection(viewerId, "messages")
    const seedClient = new QueryClient()
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "categories"),
      [],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "channels"),
      [{
        id: "persisted-dm",
        serverId: null,
        categoryId: null,
        name: "",
        type: "dm",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        position: 0,
        archived: false,
        muted: false,
        unread: false,
        tags: [],
        pending: false,
        lastMessageAt: null,
      }],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "channelMemberships"),
      [
        {
          id: `persisted-dm:${viewerId}:access`,
          channelId: "persisted-dm",
          userId: viewerId,
          relation: "access",
        },
        {
          id: "persisted-dm:peer:access",
          channelId: "persisted-dm",
          userId: "peer",
          relation: "access",
        },
      ],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "profiles"),
      [{
        userId: "peer",
        name: "Persisted peer",
        discriminator: "0001",
        avatar: "P",
        avatarVersion: 0,
      }],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(canonicalKey, [message], {
      updatedAt: Date.now() - 60_000,
    })
    const persisted: PersistedClient = {
      timestamp: Date.now(),
      buster: PERSIST_BUSTER,
      clientState: dehydrate(seedClient),
    }
    let resolveRestore!: (client: PersistedClient) => void
    persister.restoreClient.mockReturnValue(new Promise((resolve) => {
      resolveRestore = resolve
    }))

    const mounted = { client: null as QueryClient | null }
    function Probe() {
      mounted.client = useQueryClient()
      const trustedRestoredPrimary = useTrustedRestoredPrimary()
      const messages = useCanonicalMessagesById()
      const dms = useDmProjection()
      return React.createElement(
        "output",
        {
          "data-testid": "canonical-message",
          "data-trusted-restored-primary": String(trustedRestoredPrimary),
        },
        [messages?.get(message.id)?.content ?? "missing", dms?.[0]?.name ?? "missing-dm"].join("|"),
      )
    }

    const renderer = render(
      <QueryProvider userId={viewerId}>
        <CurrentUserProvider initialUser={{
          id: viewerId,
          name: "Restored viewer",
          email: "viewer@example.test",
          avatar: "V",
          avatarVersion: 0,
        }}>
          <Probe />
        </CurrentUserProvider>
      </QueryProvider>,
    )

    await waitFor(() => expect(persister.restoreClient).toHaveBeenCalledOnce())
    expect(mounted.client?.getQueryState(canonicalKey)).toMatchObject({
      data: undefined,
      status: "pending",
    })

    await act(async () => resolveRestore(persisted))
    await waitFor(() => {
      expect(screen.getByTestId("canonical-message").textContent)
        .toBe(`${message.content}|Persisted peer`)
    })
    expect(screen.getByTestId("canonical-message"))
      .toHaveAttribute("data-trusted-restored-primary", "true")
    expect(mounted.client?.getQueryData(canonicalKey)).toEqual([message])

    act(() => renderer.unmount())
  })
})
