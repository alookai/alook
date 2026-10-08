import { useToggleReactionApi } from "@/hooks/community/mutations/message-reactions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { runInNewContext } from "node:vm"
import {
  dehydrate,
  QueryClient,
  useIsRestoring,
  useQueryClient,
} from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER, type QualifiedPersister } from "@/lib/query-persister"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import {
  useCanonicalMessagesById,
  useOptionalCommunityDbRegistry,
  useDmProjection,
  useTrustedRestoredPrimary,
} from "@/lib/community-db/projections"

const persister = vi.hoisted(() => ({
  persistClient: vi.fn(() => Promise.resolve()),
  restoreClient: vi.fn(),
  removeClient: vi.fn(() => Promise.resolve()),
  isCurrent: vi.fn(async () => true),
  retireAccount: vi.fn(async () => {}),
  retireChannels: vi.fn(async () => {}),
}))
const session = vi.hoisted(() => ({ viewer: "restore-order-viewer" }))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: session.viewer } }, isPending: false, error: null }),
  currentSessionViewer: () => session.viewer,
}))

vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/query-persister", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-persister")>()
  return {
    ...actual,
    createIdbPersister: vi.fn(() => persister satisfies QualifiedPersister),
  }
})

import { QueryProvider } from "./QueryProvider"
import { CommunityRestoreBoundary } from "@/components/community/shell/community-restore-bootstrap"
import { createCommunityDbRegistry, getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCommunityRuntime, useCommunityRuntime } from "@/stores/community/runtime"
import { applyTypingIndicator } from "@/hooks/community/community-ws/typing"
import { useCommunityStore } from "@/stores/community"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock("@/hooks/community/use-servers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/community/use-servers")>(),
  useServer: () => ({ server: { id: "strict-server", categories: [{ id: "strict-category", channels: [{ id: "strict-route", type: "text" }] }] } }),
}))

afterEach(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  session.viewer = "restore-order-viewer"
  persister.persistClient.mockClear()
  persister.restoreClient.mockReset()
  persister.removeClient.mockClear()
  persister.isCurrent.mockClear()
  persister.retireAccount.mockClear()
})

describe("QueryProvider persistence ordering", () => {
  it.each([0, 1_000])("preserves the original server snapshot timestamp through legacy position migration (%s)", async (updatedAt) => {
    const client = new QueryClient()
    const key = communityKeys.communityDbCollection("restore-order-viewer", "servers")
    client.setQueryData(key, [{ id: "legacy-server", name: "Legacy", discriminator: "0001", description: "", ownerId: "restore-order-viewer", icon: null, official: false, isOwner: true, unread: false, mentions: 0 }], { updatedAt })
    const registry = createCommunityDbRegistry(client, "restore-order-viewer")
    registry.captureRestoredCollections()
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt)
    expect(client.getQueryData(key)).toEqual([expect.objectContaining({ id: "legacy-server", position: 0 })])
    expect(registry.hasRestoredCollection("servers")).toBe(updatedAt > 0)
    expect(registry.hasRestoredData()).toBe(updatedAt > 0)
    await registry.cleanup()
    client.clear()
  })
  it.each([false, true])("distinguishes the SSR self profile from an actual restored profile (%s)", async (hasDiskSnapshot) => {
    const viewerId = "restore-order-viewer"
    const profileKey = communityKeys.communityDbCollection(viewerId, "profiles")
    const seed = new QueryClient()
    seed.setQueryData(profileKey, [{ userId: viewerId, name: "Disk viewer", discriminator: "0001", avatar: "D", avatarVersion: 1 }], { updatedAt: Date.now() - 60_000 })
    persister.restoreClient.mockResolvedValue(hasDiskSnapshot ? { buster: PERSIST_BUSTER, timestamp: Date.now(), clientState: dehydrate(seed) } : undefined)
    const mark = vi.spyOn(performance, "mark")
    mark.mockClear()
    let registry!: NonNullable<ReturnType<typeof useOptionalCommunityDbRegistry>>
    let restoring = true
    function Probe() {
      const current = useOptionalCommunityDbRegistry()!
      const pending = useIsRestoring()
      React.useLayoutEffect(() => { registry = current; restoring = pending })
      return null
    }
    const renderer = render(<QueryProvider userId={viewerId} initialUser={{ id: viewerId, name: "SSR viewer", email: "viewer@example.test", avatar: "S", avatarVersion: 0 }}>
      <CommunityRestoreBoundary><Probe /></CommunityRestoreBoundary>
    </QueryProvider>)
    await waitFor(() => expect(restoring).toBe(false))
    expect(registry.hasRestoredData()).toBe(hasDiskSnapshot)
    expect(registry.hasRestoredCollection("profiles")).toBe(hasDiskSnapshot)
    await waitFor(() => expect(registry.collections.profiles.get(viewerId)?.name).toBe(hasDiskSnapshot ? "Disk viewer" : "SSR viewer"))
    expect(mark.mock.calls.filter(([name]) => name === "alook:restore:first-cached-paint")).toHaveLength(hasDiskSnapshot ? 1 : 0)
    mark.mockRestore()
    renderer.unmount()
    await waitFor(() => expect(registry.collections.profiles.status).toBe("cleaned-up"))
    seed.clear()
  })
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

    const mounted = { client: null as QueryClient | null, registry: null as ReturnType<typeof useOptionalCommunityDbRegistry> }
    function Probe() {
      mounted.client = useQueryClient()
      mounted.registry = useOptionalCommunityDbRegistry()
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
    await waitFor(() => {
      expect(mounted.registry?.collections.messages.status).toBe("cleaned-up")
      expect(mounted.registry?.collections.messages.size).toBe(0)
      expect(mounted.client?.getQueryData(canonicalKey)).toBeUndefined()
    })
  })
})

describe("QueryProvider real DbClient Strict Mode ownership", () => {
  it("receives foreign-realm preload cancellation through the actual provider", async () => {
    session.viewer = "foreign-cancel"
    persister.restoreClient.mockResolvedValue(undefined)
    const cancellation: unknown = runInNewContext('Object.assign(new Error("cancelled"), { name: "AbortError" })')
    expect(cancellation).not.toBeInstanceOf(Error)
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    let registry!: NonNullable<ReturnType<typeof getCommunityDbRegistry>>
    let preload!: ReturnType<typeof vi.spyOn>
    function Probe() {
      registry = useOptionalCommunityDbRegistry()!
      React.useLayoutEffect(() => {
        preload = vi.spyOn(registry, "preload").mockRejectedValueOnce(cancellation)
      }, [])
      return null
    }
    try {
      const renderer = render(<QueryProvider userId="foreign-cancel"><Probe /></QueryProvider>)
      await waitFor(() => expect(preload).toHaveBeenCalledOnce())
      await act(async () => { await Promise.resolve() })
      expect(report).not.toHaveBeenCalledWith("Community collection preload failed", cancellation)
      act(() => renderer.unmount())
      await waitFor(() => expect(registry.collections.messages.status).toBe("cleaned-up"))
      expect(registry.queryClient.getQueryCache().getAll()).toHaveLength(0)
    } finally { report.mockRestore() }
  })

  it("receives cancellation and cleanup promises while reporting ordinary preload and cleanup failures", async () => {
    session.viewer = "failure-receiver"
    persister.restoreClient.mockResolvedValue(undefined)
    const cancellation: unknown = runInNewContext('Object.assign(new Error("cancelled"), { name: "AbortError" })')
    const preloadFailure = new Error("ordinary preload failure")
    const cleanupFailure = new Error("ordinary cleanup failure")
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    let registry!: NonNullable<ReturnType<typeof getCommunityDbRegistry>>
    function Probe() {
      registry = useOptionalCommunityDbRegistry()!
      React.useLayoutEffect(() => {
        vi.spyOn(registry, "preload").mockRejectedValueOnce(preloadFailure)
        const cancel = registry.queryClient.cancelQueries.bind(registry.queryClient)
        vi.spyOn(registry.queryClient, "cancelQueries").mockImplementation(async (...args) => {
          await cancel(...args)
          throw cancellation
        })
        const cleanupRegistry = registry.cleanup.bind(registry)
        vi.spyOn(registry, "cleanup").mockImplementation(async () => {
          await cleanupRegistry()
          throw cleanupFailure
        })
      }, [])
      return null
    }
    try {
      const renderer = render(<QueryProvider userId="failure-receiver"><Probe /></QueryProvider>)
      await waitFor(() => expect(report).toHaveBeenCalledWith("Community collection preload failed", preloadFailure))
      act(() => renderer.unmount())
      await waitFor(() => expect(report).toHaveBeenCalledWith("Community collection cleanup failed", cleanupFailure))
      expect(report).not.toHaveBeenCalledWith("Community query cancellation failed", cancellation)
      expect(registry.collections.messages.status).toBe("cleaned-up")
      expect(registry.queryClient.getQueryCache().getAll()).toHaveLength(0)
    } finally { report.mockRestore() }
  })

  it("keeps child layout on the retained registry and cleans captured resources on final exit", async () => {
    session.viewer = "strict-viewer"
    persister.restoreClient.mockResolvedValue(undefined)
    const seen: Array<{ same: boolean; runtimeSame: boolean }> = []
    const cleanupReads: boolean[] = []
    const requestOwners: Array<ReturnType<typeof getCommunityDbRegistry>> = []
    const requestResults: Array<string> = []
    const fetch = vi.fn((_input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify({ id: "strict-peer", name: "Strict response" }), { status: 200 })))
    vi.stubGlobal("fetch", fetch)
    let original: ReturnType<typeof getCommunityDbRegistry> = null
    let client: QueryClient | null = null
    let layoutRuns = 0
    let reactToMessage!: ReturnType<typeof useToggleReactionApi>
    const revoke = vi.fn()
    const originalRevoke = URL.revokeObjectURL
    URL.revokeObjectURL = revoke
    function RouteConsumer() {
      reactToMessage = useToggleReactionApi()
      useChannelRouteModel("strict-server", "strict-server", "strict-route", "strict-viewer")
      const qc = useQueryClient()
      const registry = useOptionalCommunityDbRegistry()!
      const runtime = useCommunityRuntime()
      const selected = useCommunityStore((state) => state.currentChannelId)
      React.useLayoutEffect(() => {
        layoutRuns++
        client = qc
        original = registry
        seen.push({ same: getCommunityDbRegistry(qc) === registry, runtimeSame: getCommunityRuntime(qc) === runtime })
        runtime.ui.actions.setCurrentChannelId("strict-route")
        requestOwners.push(registry)
        const controller = new AbortController()
        void apiFetchProfiles<{ id: string; name: string }>("/api/community/users/strict-peer/profile", (profile) => [{ id: profile.id, identityAbout: { name: profile.name } }], { signal: controller.signal }, registry)
          .then((data) => { requestResults.push(data.name) }, (error: unknown) => { requestResults.push((error as { name: string }).name) })
        return () => { controller.abort(); runtime.ui.actions.setCurrentChannelId(null) }
      }, [qc, registry, runtime])
      React.useEffect(() => () => {
        cleanupReads.push(runtime === registry.runtime)
        runtime.ui.actions.unsubscribe()
      }, [registry, runtime])
      return <output data-testid="strict-route">{selected}</output>
    }
    try {
      const renderer = render(<React.StrictMode><QueryProvider userId="strict-viewer"><RouteConsumer /></QueryProvider></React.StrictMode>)
      await waitFor(() => expect(screen.getByTestId("strict-route").textContent).toBe("strict-route"))
      await waitFor(() => expect(requestResults).toEqual(["AbortError", "Strict response"]))
      expect(requestOwners).toEqual([original, original])
      expect(fetch.mock.calls.filter(([input]) => String(input).includes("/users/strict-peer/profile"))).toHaveLength(1)
      expect(original!.collections.profiles.get("strict-peer")?.name).toBe("Strict response")
      expect(layoutRuns).toBe(2)
      expect(seen).toEqual([{ same: true, runtimeSame: true }, { same: true, runtimeSame: true }])
      expect(original!.runtime.lifecycle.get().active).toBe(true)
      expect(original!.collections.messages.status).not.toBe("cleaned-up")
      await act(async () => {
        applyTypingIndicator(client!, "ch:strict-route", "peer", "Peer")
        reactToMessage({ messageId: "strict-message", emoji: "👍", userId: "strict-viewer", currentMe: false })
        original!.runtime.messageStream.actions.accept({ kind: "dm", id: "strict-dm" }, {
          nonce: "strict-nonce", tempId: "strict-temp",
          message: { type: "chat", authorId: "strict-viewer", content: "pending", createdAt: new Date().toISOString() },
          localUploads: [{ file: new File(["x"], "preview.png"), previewObjectUrl: "blob:strict-preview" }],
        })
      })
      const originalRequests = fetch.mock.calls.map(([input]) => String(input))
      act(() => renderer.unmount())
      await waitFor(() => expect(original!.runtime.lifecycle.get().active).toBe(false))
      await waitFor(() => expect(original!.collections.messages.status).toBe("cleaned-up"))
      expect(getCommunityDbRegistry(client!)).toBeNull()
      expect(cleanupReads).toEqual([true, true])
      expect(original!.runtime.ui.get().typingTimers.size).toBe(0)
      await waitFor(() => expect(client!.isMutating({ mutationKey: ["community", "message-reaction"] })).toBe(0))
      expect(fetch.mock.calls.filter(([input]) => String(input).includes("/users/strict-peer/profile"))).toHaveLength(1)
      expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(originalRequests)
      expect(original!.runtime.messageStream.get().entries.size).toBe(0)
      expect(revoke).toHaveBeenCalledWith("blob:strict-preview")
    } finally { URL.revokeObjectURL = originalRevoke; vi.unstubAllGlobals() }
  })
})
