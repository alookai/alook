import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./collections"
import { canonicalChannelRow, type CommunityCollectionName } from "./schema"
import {
  captureCommunityLiveSnapshotToken,
  discardCommunityRestoreReplacements,
  projectCommunityWsEventToDb,
  publishCommunityLiveSnapshot,
  publishCommunityMessages,
  restoreCommunityCollections,
} from "./sync"

const owners: Array<{ registry: CommunityDbRegistry; release: () => void }> = []
function owner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release!: () => void
  const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>((resolve) => { release = resolve }) })
  owners.push({ registry, release })
  return { client, registry, release }
}

function input(rows: Partial<Record<CommunityCollectionName, object[]>>) {
  const client = new QueryClient()
  for (const [name, data] of Object.entries(rows)) client.setQueryData(communityKeys.communityDbCollection("viewer", name), data, { updatedAt: 0 })
  const restored = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) }, "viewer")
  expect(Object.keys(restored).sort()).toEqual(Object.keys(rows).sort())
  client.clear()
  return restored
}

const message = (id: string, channelId = "c1", content = "Disk") => ({ id, channelId, resourceComplete: false as const, type: "chat" as const, content, seq: 1, createdAt: "2026-10-01T00:00:00.000Z" })
const server = (id: string) => ({ id, position: 0, name: id, discriminator: "0001", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true, unread: false, mentions: 0, detailComplete: false })

afterEach(async () => {
  for (const { registry, release } of owners.splice(0)) {
    release()
    discardCommunityRestoreReplacements(registry)
    await registry.cleanup()
    registry.queryClient.clear()
  }
})

describe("canonical disk input precedence", () => {
  it("keeps fresh RSC fields and fills uncovered rows before releasing the single restore gate", async () => {
    const { client, registry, release } = owner()
    const profileKey = communityKeys.communityDbCollection("viewer", "profiles")
    client.setQueryData(profileKey, [{ id: "viewer", identityComplete: false, name: "RSC", avatarVersion: 4 }])
    const disk = input({
      profiles: [{ id: "viewer", identityComplete: false, name: "Disk", avatarVersion: 1, aboutMe: "Uncovered" }, { id: "peer", identityComplete: false, name: "Peer" }],
      messages: [message("old-other-scope", "other")],
    })
    await restoreCommunityCollections(registry, disk)
    expect(client.getQueryData(profileKey)).toEqual([
      { id: "viewer", identityComplete: false, name: "RSC", avatarVersion: 4, aboutMe: "Uncovered" },
      { id: "peer", identityComplete: false, name: "Peer" },
    ])
    expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "messages"))).toEqual(disk.messages!.rows)
    registry.captureRestoredCollections(disk)
    expect(registry.hasRestoredCollection("messages")).toBe(true)
    release()
    await registry.preload()
    expect(registry.collections.messages.get("old-other-scope")?.content).toBe("Disk")
    expect(registry.collections.profiles.get("viewer")?.name).toBe("RSC")
  })

  it("preserves a WS patch that arrived before its disk row and a current message over old disk", async () => {
    const { client, registry } = owner()
    publishCommunityMessages(client, { channelId: "c1", messages: [message("current", "c1", "RSC")], proof: { token: captureCommunityLiveSnapshotToken(client) } })
    projectCommunityWsEventToDb(client, { type: "community:message.edited", serverId: "s1", channelId: "c1", messageId: "pending", content: "WS" })
    await restoreCommunityCollections(registry, input({ messages: [message("current"), message("pending"), message("uncovered", "other")] }))
    const rows = client.getQueryData<Array<ReturnType<typeof message>>>(communityKeys.communityDbCollection("viewer", "messages"))!
    expect(rows.map((row) => [row.id, row.content])).toEqual([["current", "RSC"], ["pending", "WS"], ["uncovered", "Disk"]])
    expect(rows[1].createdAt).toBe(message("pending").createdAt)
  })

  it("does not revive a target or its messages after revoke or delete during IDB restore", async () => {
    const { client, registry } = owner()
    registry.runtime.ws.actions.revokeChannelAccess("s1", "revoked")
    projectCommunityWsEventToDb(client, { type: "community:channel.delete", serverId: "s1", channelId: "deleted" })
    const disk = input({
      channels: ["revoked", "deleted", "kept"].map((id) => canonicalChannelRow({ id, type: "text", serverId: "s1" })),
      messages: [message("revoked-message", "revoked"), message("deleted-message", "deleted"), message("kept-message", "kept")],
    })
    await restoreCommunityCollections(registry, disk)
    expect(client.getQueryData<Array<{ id: string }>>(communityKeys.communityDbCollection("viewer", "channels"))?.map((row) => row.id)).toEqual(["kept"])
    expect(client.getQueryData<Array<{ id: string }>>(communityKeys.communityDbCollection("viewer", "messages"))?.map((row) => row.id)).toEqual(["kept-message"])
  })

  it("preserves authoritative empty scopes and still restores an unrelated server", async () => {
    const { client, registry } = owner()
    publishCommunityLiveSnapshot(client, {
      snapshot: { kind: "server-detail", data: { id: "s1", name: "Fresh", discriminator: "0001", description: "", icon: null, ownerId: "viewer", categories: [] } },
      proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined },
    })
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "folders", data: { folders: [] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
    const disk = input({
      servers: [server("s1"), server("s2")],
      categories: [{ id: "old-category", serverId: "s1", name: "Old", position: 0, private: false, pending: false }],
      channels: [canonicalChannelRow({ id: "omitted", type: "text", serverId: "s1" }), canonicalChannelRow({ id: "other", type: "text", serverId: "s2" })],
      messages: [message("omitted-message", "omitted"), message("other-message", "other")],
      folders: [{ id: "old-folder", name: "Old", position: 0 }],
      folderItems: [{ id: "old-folder:s1", folderId: "old-folder", serverId: "s1", position: 0 }],
    })
    await restoreCommunityCollections(registry, disk)
    expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "folders"))).toEqual([])
    expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "folderItems"))).toEqual([])
    expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "categories"))).toEqual([])
    expect(client.getQueryData<Array<{ id: string }>>(communityKeys.communityDbCollection("viewer", "messages"))?.map((row) => row.id)).toEqual(["other-message"])
    expect(client.getQueryData<Array<{ id: string; name: string }>>(communityKeys.communityDbCollection("viewer", "servers"))?.map((row) => [row.id, row.name])).toEqual([["s1", "Fresh"], ["s2", "s2"]])
  })

  it("classifies only this restore input, including confirmed empty, regardless of current Query timestamps", () => {
    const { client, registry } = owner()
    client.setQueryData(communityKeys.communityDbCollection("viewer", "profiles"), [{ id: "viewer", identityComplete: false, name: "RSC" }])
    registry.captureRestoredCollections(input({ messages: [] }))
    expect(registry.hasRestoredCollection("profiles")).toBe(false)
    expect(registry.hasRestoredCollection("messages")).toBe(true)
    expect(registry.hasRestoredData()).toBe(false)
  })

  it("awaits an initialized native collection commit before completing restore", async () => {
    const { registry, release } = owner()
    release()
    await registry.preload()
    let commit!: () => void
    const actual = registry.collections.messages.utils.writeBatch.bind(registry.collections.messages.utils)
    const delayed = vi.spyOn(registry.collections.messages.utils, "writeBatch").mockImplementation((callback) => {
      const written = actual(callback)
      return written.then(() => new Promise<void>((resolve) => { commit = resolve }))
    })
    let completed = false
    const restoring = restoreCommunityCollections(registry, input({ messages: [message("late")] })).then(() => { completed = true })
    await vi.waitFor(() => expect(commit).toBeTypeOf("function"))
    expect(completed).toBe(false)
    commit()
    await restoring
    expect(completed).toBe(true)
    expect(registry.collections.messages.get("late")?.content).toBe("Disk")
    delayed.mockRestore()
  })
})
