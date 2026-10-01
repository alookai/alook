import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useLayoutEffect, useRef } from "react"
import {
  dehydrate,
  QueryClient,
  useQueryClient,
} from "@tanstack/react-query"
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER } from "@/lib/query-persister"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestServerDetail } from "@/lib/community-db/sync"
import { useServer } from "@/hooks/community/use-servers"
import { ChannelSidebarScope } from "@/components/community/channels/channel-sidebar-tree-owner"
import { tid } from "@/lib/community/testids"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import {
  useCanonicalMessagesById,
  useDmProjection,
  useTrustedRestoredPrimary,
} from "@/lib/community-db/projections"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

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
  apiFetchMock.mockReset()
  apiFetchMock.mockImplementation(() => new Promise(() => {}))
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


describe("canonical target tree first readable commit", () => {
  it.each(["complete", "empty", "incomplete", "missing", "other-account", "other-target"] as const)(
    "keeps unknown separate from the restored %s target",
    async (kind) => {
      const viewerId = "target-restore-viewer"
      const seed = new QueryClient()
      const seedRegistry = createCommunityDbRegistry(seed, kind === "other-account" ? "former-viewer" : viewerId)
      const { cleanup: disposeSeedRegistry } = seedRegistry
      await seedRegistry.preload()
      if (kind !== "missing") {
        ingestServerDetail(seedRegistry, {
          id: kind === "other-target" ? "foreign-target" : "target", name: "Target", discriminator: "0001", description: "", icon: null, ownerId: viewerId,
          categories: kind === "empty" ? [] : [{ id: "category", name: "Category", channels: [
            { id: "leaf", name: "leaf", type: "text", active: false, unread: false },
          ] }],
        })
      }
      if (kind === "incomplete") {
        seed.setQueryData(communityKeys.communityDbCollection(viewerId, "servers"),
          [{ ...seedRegistry.collections.servers.get("target"), detailComplete: false }])
      }
      const snapshot: PersistedClient = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) }
      await disposeSeedRegistry()
      seed.clear()
      let resolveRestore!: (client: PersistedClient) => void
      persister.restoreClient.mockReturnValue(new Promise<PersistedClient>((resolve) => { resolveRestore = resolve }))
      const commits: Array<{ ready: boolean; cold: boolean; row: boolean; scope: string | undefined }> = []
      let client!: QueryClient
      function Target() {
        client = useQueryClient()
        const { server } = useServer("target")
        const ref = useRef<HTMLDivElement>(null)
        useLayoutEffect(() => {
          commits.push({ ready: server !== null,
            cold: !!ref.current?.querySelector(`[data-testid="${tid.channelSidebarPending("target")}"]`),
            row: !!ref.current?.querySelector(`[data-testid="${tid.channelRow("leaf")}"]`),
            scope: ref.current?.querySelector<HTMLElement>("[data-community-channel-tree-scope]")?.dataset.communityChannelTreeScope })
        })
        return <div ref={ref}><ChannelSidebarScope categories={server?.categories ?? null}
          scopeKey="server:target" targetServerId="target" serverId="target" serverName="Target"
          activeChannel="leaf" setActiveChannel={vi.fn()} isAdmin={false} currentUserId={viewerId} /></div>
      }
      const mounted = render(<QueryProvider userId={viewerId}>
        <CurrentUserProvider initialUser={{ id: viewerId, name: "Viewer", email: "viewer@example.test", avatar: "V", avatarVersion: 0 }}>
          <Target />
        </CurrentUserProvider>
      </QueryProvider>)
      try {
        await waitFor(() => expect(persister.restoreClient).toHaveBeenCalledOnce())
        expect(commits.length).toBeGreaterThan(0)
        expect(commits.every((commit) => !commit.ready && commit.cold && !commit.row && !commit.scope)).toBe(true)
        expect(apiFetchMock).not.toHaveBeenCalled()
        await act(async () => resolveRestore(snapshot))
        const readable = kind === "complete" || kind === "empty"
        await waitFor(() => {
          expect(client.getQueryData(communityKeys.communityDbCollection(viewerId, "channels"))).toBeDefined()
          if (readable) expect(commits.some((commit) => commit.ready)).toBe(true)
          else expect(apiFetchMock).toHaveBeenCalled()
        })
        if (readable) {
          const first = commits.findIndex((commit) => commit.ready)
          expect(commits.slice(first).every((commit) => commit.ready && !commit.cold && commit.scope === "server:target" && commit.row === (kind === "complete"))).toBe(true)
          expect(client.getQueryData(communityKeys.communityDbCollection(viewerId, "servers"))).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "target", detailComplete: true })]))
        } else {
          expect(commits.every((commit) => !commit.ready && commit.cold && !commit.row && !commit.scope)).toBe(true)
        }
      } finally {
        act(() => mounted.unmount())
        await client.cancelQueries()
        client.clear()
      }
    },
  )
})
