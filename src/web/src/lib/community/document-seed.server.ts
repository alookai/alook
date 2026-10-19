import { QueryClient } from "@tanstack/react-query"
import { and, eq, inArray } from "@tanstack/react-db"
import type { Database } from "@alook/shared"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityCollectionQuery, communityJoinedMessagesQuery } from "@/lib/community-db/queries"
import { dehydrateCommunityProjections, preloadCommunityProjection } from "@/lib/community-db/live-query"
import { communityKeys } from "@/lib/query-keys"
import { resolveCommunityModulePlan } from "./community-route"
import { readCommunityDocumentRoute } from "./document-route"
import { installCommunityDocumentSeed, type CommunityDocumentSeed } from "./document-seed"
import { resolveMessageTarget } from "./message-door"
import { readCommunityConversationEntry } from "./conversation-entry.server"
import { parseCommunityMessageWindow } from "./messages"
import type { CommunitySelfProfile } from "./self-profile.server"
import { readCommunityBots } from "./bots.server"
import { readCommunityMachineList } from "./machines.server"
import { readCommunityServerDirectory } from "./server-directory.server"

export async function readCommunityDocumentSeed(db: Database, viewerId: string, href: string | null, selfProfile: CommunitySelfProfile): Promise<CommunityDocumentSeed> {
  const seed: CommunityDocumentSeed = { viewerId, href: readCommunityDocumentRoute(href), generatedAt: Date.now(), selfProfile, entries: [], db: { collections: [] } }
  const main = seed.href ? resolveCommunityModulePlan(seed.href).main : { kind: "none" as const }
  const channelId = main.kind === "dm" ? main.dmId : main.kind === "server-conversation" ? main.leafId : null
  const serverId = main.kind === "server-conversation" ? main.serverId : null
  let phase: "read-module" | "resolve-target" | "read-entry" = "read-module"
  try {
    if (main.kind === "bots") {
      const [bots, machines] = await Promise.allSettled([
        readCommunityBots(db, viewerId),
        readCommunityMachineList(db, viewerId),
      ])
      if (bots.status === "fulfilled") seed.bots = bots.value
      if (machines.status === "fulfilled") seed.machines = machines.value
      if (bots.status === "rejected") throw bots.reason
      if (machines.status === "rejected") throw machines.reason
    }
    if (main.kind === "machines") seed.machines = await readCommunityMachineList(db, viewerId)
    if (main.kind === "server-landing") seed.server = await readCommunityServerDirectory(db, viewerId, main.serverId)
    if (channelId && seed.href) {
      const url = new URL(seed.href, "https://alook.invalid")
      const anchorMessageId = url.searchParams.get("msg")
      const tag = url.searchParams.get("tag")?.trim().toLowerCase() || undefined
      const read = async (id: string, anchor?: string | null, filter?: string) => {
        phase = "resolve-target"
        const resolved = await resolveMessageTarget(db, viewerId, { id }, "human", "read")
        if (!resolved.ok || resolved.value.access.channel.serverId !== serverId) return
        const params = new URLSearchParams(anchor ? { anchor } : undefined)
        phase = "read-entry"
        const result = await readCommunityConversationEntry(db, { viewerId, target: resolved.value, window: parseCommunityMessageWindow(params), tag: filter, preferTail: false })
        if (result.ok) seed.entries.push({ target: { channelId: id, serverId, anchorMessageId: anchor ?? null, tag: filter ?? null }, data: result.entry })
        return result.ok ? result.entry : undefined
      }
      await read(channelId, anchorMessageId, tag)
    }
  } catch {
    console.warn("[community] document resource prefetch unavailable", { kind: main.kind, phase, channelId, generatedAt: seed.generatedAt })
  }
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  const registry = createCommunityDbRegistry(client, viewerId)
  try {
    installCommunityDocumentSeed(client, registry, seed, viewerId)
    await registry.preload()
    const descriptors: unknown[] = [
      communityCollectionQuery(registry, "profiles", ({ row }) => eq(row.id, viewerId)),
      communityCollectionQuery(registry, "profiles", () => eq(1, 1)),
      communityCollectionQuery(registry, "channels"),
    ]
    for (const { target, data } of seed.entries) {
      const channelId = target.channelId
      descriptors.push(communityCollectionQuery(registry, "channels", ({ row }) => eq(row.id, channelId)))
      if (data.parent) descriptors.push(communityCollectionQuery(registry, "channels", ({ row }) => eq(row.id, data.parent!.id)))
      if (data.forumFeed) continue
      const resource = client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries(channelId) })[0]?.state.data as { windowKey: readonly unknown[] } | undefined
      const window = resource ? client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(resource.windowKey) : undefined
      const ids = window?.pages.flatMap(page => page.messages.map(message => message.id)) ?? []
      descriptors.push(communityJoinedMessagesQuery(registry, channelId, ids))
    }
    for (const { data } of seed.entries) if (data.forumFeed) {
      const ids = data.forumFeed.threads.flatMap(thread => thread.parentMessageId ? [thread.parentMessageId] : [])
      descriptors.push(communityJoinedMessagesQuery(registry, undefined, ids))
    }
    for (const { data } of seed.entries) if (data.opener) {
      descriptors.push(communityJoinedMessagesQuery(registry, undefined, [data.opener.id]))
      if (data.opener.authorId) descriptors.push(communityCollectionQuery(registry, "profiles", ({ row }) => eq(row.id, data.opener!.authorId)))
    }
    const dmIds = seed.entries.filter(entry => entry.data.channel.type === "dm").map(entry => entry.data.channelId)
    if (seed.bots) descriptors.push(communityCollectionQuery(registry, "profiles", ({ row }) => inArray(row.id, seed.bots!.bots.map(bot => bot.id))))
    if (seed.server) {
      const serverId = seed.server.id
      descriptors.push(
        communityCollectionQuery(registry, "servers", ({ row }) => eq(row.id, serverId)),
        communityCollectionQuery(registry, "categories", ({ row }) => eq(row.serverId, serverId)),
        communityCollectionQuery(registry, "channels", ({ row }) => and(eq(row.serverId, serverId), eq(1, 1))),
      )
    }
    if (dmIds.length) {
      const peers = seed.entries.flatMap(entry => entry.data.peer ? [entry.data.peer.id] : [])
      descriptors.push(
        communityCollectionQuery(registry, "channels", ({ row }) => and(eq(1, 1), eq(row.type, "dm"))),
        communityCollectionQuery(registry, "channelMemberships", ({ row }) => inArray(row.channelId, dmIds)),
        communityCollectionQuery(registry, "profiles", ({ row }) => inArray(row.id, peers)),
        communityCollectionQuery(registry, "readStates", ({ row }) => inArray(row.channelId, dmIds)),
      )
    }
    const bindings = await Promise.all(descriptors.map(descriptor => preloadCommunityProjection(registry, descriptor)))
    const state = dehydrateCommunityProjections(registry, bindings)
    return JSON.parse(JSON.stringify({ ...seed, db: { ...state, collections: [] } })) as CommunityDocumentSeed
  } finally {
    await registry.cleanup()
    client.clear()
  }
}
