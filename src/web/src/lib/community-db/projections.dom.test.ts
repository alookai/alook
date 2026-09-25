import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React, { type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { createCommunityDbRegistry } from "./collections"
import {
  CommunityDbProvider,
  useCanonicalCommunityProfile,
  useCanonicalMessagesById,
  useCanonicalProfilesByUserId,
  useChannelRefDirectoryProjection,
  useDmProjection,
  useMessageProjection,
  useNotificationSettingsProjection,
  useRouteChannelProjection,
  useServerRailProjection,
  useServerTreeProjection,
  useTrustedRestoredPrimary,
} from "./projections"
import { ingestServerDetail, ingestServers } from "./sync"

describe("community DB projections", () => {
  it("keeps every projection unresolved without a registry owner", () => {
    const rendered = renderHook(() => ({
      restored: useTrustedRestoredPrimary(),
      rail: useServerRailProjection(),
      tree: useServerTreeProjection("s1"),
      dms: useDmProjection(),
      route: useRouteChannelProjection("c1"),
      messages: useMessageProjection("c1"),
      messagesById: useCanonicalMessagesById(),
      notifications: useNotificationSettingsProjection(),
      directory: useChannelRefDirectoryProjection(),
    }))

    expect(rendered.result.current).toEqual({
      restored: false,
      rail: undefined,
      tree: undefined,
      dms: undefined,
      route: undefined,
      messages: undefined,
      messagesById: undefined,
      notifications: undefined,
      directory: undefined,
    })
    rendered.unmount()
  })

  it("uses an explicit preview profile map instead of canonical presence", () => {
    const preview = new Map([[
      "preview",
      { id: "preview", name: "Preview", discriminator: "0001", avatar: "P", avatarVersion: 1 },
    ]])
    const wrapper = ({ children }: { children: ReactNode }) => React.createElement(
      CommunityPreviewProfileOwner,
      { profiles: preview },
      children,
    )
    const rendered = renderHook(useCanonicalProfilesByUserId, { wrapper })
    expect(rendered.result.current).toBe(preview)
    rendered.unmount()
  })

  it("requires completed detail before projecting a rail server tree", async () => {
    const queryClient = new QueryClient()
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    ingestServers(registry, {
      servers: [{
        id: "s1",
        name: "Server",
        initial: "S",
        active: false,
        unread: false,
        mentions: 0,
        ownerId: "viewer",
      }],
    })
    const wrapper = ({ children }: { children: ReactNode }) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(() => useServerTreeProjection("s1"), { wrapper })

    expect(rendered.result.current).toBeUndefined()
    act(() => ingestServerDetail(registry, {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [],
    }))
    await waitFor(() => expect(rendered.result.current).toMatchObject({
      id: "s1",
      categories: [],
    }))

    act(() => ingestServers(registry, {
      servers: [{
        id: "s1",
        name: "Server renamed",
        initial: "S",
        active: false,
        unread: false,
        mentions: 0,
        ownerId: "viewer",
      }],
    }))
    await waitFor(() => expect(rendered.result.current?.name).toBe("Server renamed"))

    rendered.unmount()
    await registry["cleanup"]()
  })

  it("projects the complete canonical graph through every read model", async () => {
    const queryClient = new QueryClient()
    const collection = (name: string, rows: unknown[]) => queryClient.setQueryData(
      communityKeys.communityDbCollection("viewer", name),
      rows,
    )
    collection("servers", [{
      id: "s1", name: "Server", discriminator: "0001", description: "desc",
      ownerId: "owner", icon: null, official: true, isOwner: false, unread: true,
      mentions: 2, detailComplete: true,
    }])
    collection("serverMemberships", [{
      id: "s1:viewer", serverId: "s1", userId: "viewer", role: "member", viewer: true,
    }])
    collection("categories", [
      { id: "cat2", serverId: "s1", name: "Later", position: 2, private: false, pending: false },
      { id: "cat1", serverId: "s1", name: "General", position: 1, private: false, pending: false },
    ])
    const channelBase = {
      position: 1, archived: false, muted: false, unread: false, tags: [], pending: false,
    }
    collection("channels", [
      { ...channelBase, id: "c2", serverId: "s1", categoryId: "cat1", name: "later", type: "text", position: 2 },
      { ...channelBase, id: "c1", serverId: "s1", categoryId: "cat1", name: "chat", type: "text", position: 1 },
      { ...channelBase, id: "forum2", serverId: "s1", categoryId: null, name: "later forum", type: "forum", position: 2 },
      { ...channelBase, id: "forum1", serverId: "s1", categoryId: null, name: "forum", type: "forum", position: 1 },
      { ...channelBase, id: "thread1", serverId: "s1", categoryId: null, name: "thread", type: "thread", parentChannelId: "forum1" },
      { ...channelBase, id: "dm1", serverId: null, categoryId: null, name: "Peer", type: "dm", preview: "hello", lastUnreadSeq: 8 },
      { ...channelBase, id: "dm-no-member", serverId: null, categoryId: null, name: "Missing", type: "dm" },
      { ...channelBase, id: "dm-no-profile", serverId: null, categoryId: null, name: "Missing profile", type: "dm" },
    ])
    collection("channelMemberships", [
      { id: "dm1:viewer:access", channelId: "dm1", userId: "viewer", relation: "access" },
      { id: "dm1:peer:access", channelId: "dm1", userId: "peer", relation: "access" },
      { id: "dm-no-profile:ghost:access", channelId: "dm-no-profile", userId: "ghost", relation: "access" },
    ])
    collection("profiles", [
      { userId: "viewer", name: "Viewer", discriminator: "0001", avatar: "V", avatarVersion: 1 },
      { userId: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 2 },
    ])
    collection("messages", [
      { id: "m2", channelId: "c1", type: "chat", authorId: "peer", content: "second", seq: 2 },
      { id: "m1", channelId: "c1", type: "chat", authorId: "peer", content: "first", seq: 1 },
    ])
    collection("readStates", [{
      channelId: "dm1", lastReadMessageId: null, lastReadAt: "2026-09-25T00:00:00.000Z",
      lastReadSeq: 7,
    }])
    collection("readStateClock", [{ id: "account", revision: 1 }])
    collection("folders", [
      { id: "f2", name: "Later", position: 2 },
      { id: "f1", name: "Folder", position: 1 },
    ])
    collection("folderItems", [
      { id: "f1:missing", folderId: "f1", serverId: "missing", position: 2 },
      { id: "f1:s1", folderId: "f1", serverId: "s1", position: 1 },
    ])
    collection("notificationSettings", [
      { id: "server:s1", serverId: "s1", level: "all" },
      { id: "channel:c1", channelId: "c1", level: "mentions" },
    ])
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    useCommunityWsStore.setState({ presenceByUserId: new Map([["peer", "online"]]) })
    const restoredListener = vi.fn()
    const unsubscribeRestored = registry.subscribeRestoredCollections(restoredListener)
    registry.captureRestoredCollections()
    registry.captureRestoredCollections()
    expect(restoredListener).toHaveBeenCalledOnce()
    unsubscribeRestored()
    const wrapper = ({ children }: { children: ReactNode }) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(() => ({
      restored: useTrustedRestoredPrimary(),
      rail: useServerRailProjection(),
      tree: useServerTreeProjection("s1"),
      dms: useDmProjection(),
      route: useRouteChannelProjection("c1"),
      messages: useMessageProjection("c1"),
      messagesById: useCanonicalMessagesById(),
      notifications: useNotificationSettingsProjection(),
      profiles: useCanonicalProfilesByUserId(),
      profile: useCanonicalCommunityProfile("peer"),
      directory: useChannelRefDirectoryProjection(),
    }), { wrapper })

    await waitFor(() => expect(rendered.result.current.restored).toBe(true))
    expect(rendered.result.current.rail?.servers).toEqual([
      expect.objectContaining({ id: "s1", name: "Server" }),
    ])
    expect(rendered.result.current.rail?.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "f1", servers: [expect.objectContaining({ id: "s1" })] }),
    ]))
    expect(rendered.result.current.tree?.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cat1", channels: expect.arrayContaining([expect.objectContaining({ id: "c1" })]) }),
      expect.objectContaining({ id: "__uncategorized__", channels: expect.arrayContaining([expect.objectContaining({ id: "forum1" })]) }),
    ]))
    expect(rendered.result.current.dms).toEqual([
      expect.objectContaining({ id: "dm1", userId: "peer", lastUnreadSeq: 8 }),
    ])
    expect(rendered.result.current.route?.id).toBe("c1")
    expect(rendered.result.current.messages?.map((message) => message.id)).toEqual(["m1", "m2"])
    expect(rendered.result.current.messagesById?.get("m2")?.content).toBe("second")
    expect(rendered.result.current.notifications).toMatchObject({
      server: { s1: "All Messages" },
      channel: { c1: "Only @mentions" },
    })
    expect(rendered.result.current.profiles.get("peer")?.id).toBe("peer")
    expect(rendered.result.current.profiles.get("peer")?.presence).toBe("online")
    expect(rendered.result.current.profile?.name).toBe("Peer")
    expect(rendered.result.current.directory).toEqual([
      expect.objectContaining({ id: "s1", channels: expect.arrayContaining([
        expect.objectContaining({ id: "c1" }),
        expect.objectContaining({ id: "thread1" }),
      ]) }),
    ])

    rendered.unmount()
    useCommunityWsStore.getState().reset()
    expect(registry.hasRestoredCollection("channels")).toBe(true)
    await registry["cleanup"]()
  })
})
