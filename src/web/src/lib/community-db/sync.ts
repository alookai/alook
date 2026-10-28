import { readForumSidebarWindowResult } from "@/lib/community/forum-sidebar-window"
import { ZodError } from "zod"
import { requestBusinessSchemaUpdate } from "@/lib/business-schema-lifecycle"
import type { DM } from "@/lib/community/models/people"
import { parseCommunityDmsRead, CommunityResourceBundleSchema, type CommunityResourceBundle } from "@alook/shared"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { ServerDirectorySnapshotSchema, recordServerDirectoryWindow, reconcileExistingServerDirectoryWindows, type ServerDirectorySnapshot } from "@/lib/community/server-directory-window"
import { serverRailTopOrder } from "@alook/shared"
import type { Transaction } from "@tanstack/react-db"
import { communityRequestOptions as qualifiedCommunityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { isAbortError } from "@/lib/errors"
import { isOwnerServerDeleteScopeEvictionBlocked } from "@/lib/community/eject-server"

import { getCommunityRuntime, readCurrentCommunityChannelMeta } from "@/stores/community/runtime-owner"
import { notifyManager,type QueryClient } from "@tanstack/react-query"
import { createStore } from "@tanstack/store"
import type { Query } from "@tanstack/react-query"
import { FORUM_ARCHIVE_TAG, CommunityChannelResourceSchema, AttentionIncludedSchema, CommunityMessageResourceSchema, CommunityMessageResourcesSchema, communityMessageProfileIds, CommunityResourceProfileSchema, CommunityMemberRelationSchema, type CommunityChannelResource, type CommunityMemberRelation, type CommunityResourceProfile, type CommunityMessageResource, type AccountAttentionSnapshot, type CommunityWsEvent, type CommunityContract, type ServerRailProjection } from "@alook/shared"
import type { DmsResponse } from "@/hooks/community/use-dms"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type {
AccountReadStateSnapshot,
} from "@/hooks/community/community-ws/read-state-reconciliation"
import type { ServersResponse } from "@/hooks/community/use-servers"
import { applyMessageReaction, messageProfileIds, type Msg, type MessageInput } from "@/lib/community/models/message"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import {
beginCommunityProfileSeed,
type CommunityProfileSeedSnapshot,
communityUserProfilePatch,
messageProfilePatches,
writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import type { CommunityProfilePatch } from "@/lib/community/models/people"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"



import { canonicalUserImage } from "@/lib/community/storage"
import { projectCommunityMessageCreate } from "@/lib/community/message-wire"
import { clearTypingIndicator } from "@/hooks/community/community-ws/typing"
import { takeMessageIdsForAccessScope } from "./message-access-scope"
import { clearLastChannel,getLastChannel } from "@/lib/community/last-channel"
import { clearLastMeLocation,getLastMeLeaf } from "@/lib/community/last-me-location"
import {
getCommunityDbRegistry,
type CommunityDbRegistry,
} from "./collections"
import { channelMembershipKey, canonicalChannelMembershipRow, channelLocalSchema, canonicalChannelRow, folderItemKey, messageSchema, notificationSettingKey, serverMembershipKey, serverMembershipSchema, serverSchema, communityCollectionSchemas, type CommunityCollectionRows, type CategoryRow, type AttentionItemRow, type AttentionScopeRow, type ChannelMembershipRow, type ChannelRow, type FolderItemRow, type FolderRow, type MessageRow, type ProfileRow, type FriendshipRow, type NotificationSettingRow, type ReadStateClockRow, type ReadStateRow, type ServerMembershipRow, type ServerRow } from "./schema"
import type { z } from "zod"
import { communityRowData, writeCommunityCollectionRows } from "./write"
import type { CommunityRestoredCollections } from "@/lib/query-persister"
import { normalizeThreadResources, type CommunityThreadResources } from "@/hooks/community/forum-feed-window"

type CollectionName = keyof CommunityDbRegistry["collections"]
type SnapshotIngestMode = "authoritative" | "merge"

type CanonicalRevisionState = {
  revision: number
  entityRevisions: Map<string, number>
  fieldRevisions: Map<string, Map<string, number>>
  pendingOperations: Map<string, CanonicalPendingOperation[]>
  restoreReplacements: Array<{ name: CollectionName; owns: (row: object) => boolean }>
}

type CanonicalPendingOperation =
  | { revision: number; kind: "patch"; apply: (row: object) => object }
  | { revision: number; kind: "delete" }

type CanonicalWriteContext =
  | { kind: "event" }
  | { kind: "query"; requestRevision: number; profileSnapshot: CommunityProfileSeedSnapshot }

const canonicalRevisionStates = new WeakMap<QueryClient, ReturnType<typeof createStore<CanonicalRevisionState>>>()
const canonicalWriteContexts = new WeakMap<QueryClient, CanonicalWriteContext>()

function writeCanonicalProfilePatches(registry: CommunityDbRegistry, patches: readonly CommunityProfilePatch[], resourceSeed = false) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  return writeCommunityProfilePatches(patches, registry, context?.kind === "query" ? { snapshot: context.profileSnapshot } : { event: context?.kind === "event", resourceSeed })
}

function canonicalRevisionStore(queryClient: QueryClient) {
  let state = canonicalRevisionStates.get(queryClient)
  if (!state) {
    state = createStore<CanonicalRevisionState>({ revision: 0, entityRevisions: new Map(), fieldRevisions: new Map(), pendingOperations: new Map(), restoreReplacements: [] })
    canonicalRevisionStates.set(queryClient, state)
  }
  return state
}

function canonicalRevisionState(queryClient: QueryClient) {
  return canonicalRevisionStore(queryClient).get()
}

function updateCanonicalRevisions(queryClient: QueryClient, update: (state: CanonicalRevisionState) => void) {
  canonicalRevisionStore(queryClient).setState((previous) => {
    const state = { ...previous, entityRevisions: new Map(previous.entityRevisions), fieldRevisions: new Map(previous.fieldRevisions), pendingOperations: new Map(previous.pendingOperations) }
    update(state)
    return state
  })
}

function canonicalEntityKey(name: CollectionName, key: string) {
  return `${name}:${key}`
}

type CompleteChannelRoster = { channelId: string; relation: "access" | "notify" }

function canonicalMembershipPresence(
  registry: CommunityDbRegistry,
  name: "channelMemberships" | "serverMemberships",
  key: string,
) {
  if (collectionRows(registry, name).some((row) => row.id === key)) return true
  if (canonicalRevisionState(registry.queryClient).pendingOperations.get(canonicalEntityKey(name, key))?.some((operation) => operation.kind === "delete")) return false
  return undefined
}

export function getCanonicalCommunityTypingMembership(
  queryClient: QueryClient,
  channelId: string,
  userId: string,
  completeRoster?: CompleteChannelRoster,
): boolean | undefined {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return undefined
  const channels = collectionRows(registry, "channels")
  const channel = channels.find((row) => row.id === channelId)
  const accessScope = registry.runtime.ws.get().channelAccessScopes.get(channelId)
  const serverId = channel?.serverId ?? accessScope?.serverId
  const parentChannelId = channel?.parentChannelId ?? accessScope?.parentChannelId
  const relationPresence = (id: string, relation: "access" | "notify") => {
    const presence = canonicalMembershipPresence(registry, "channelMemberships", channelMembershipKey(id, userId, relation))
    if (presence !== undefined) return presence
    if (completeRoster?.channelId === id && completeRoster.relation === relation) return false
    const roster = queryClient.getQueryData<{ serverId: string | null; relation: "access" | "notify"; members: readonly { userId: string }[] }>(communityKeys.channelMembers(id, relation))
    const rosterChannel = channels.find((row) => row.id === id)
    if (roster?.relation === relation && (!rosterChannel || roster.serverId === rosterChannel.serverId)
      && !roster.members.some((member) => member.userId === userId)) return false
    return undefined
  }
  const serverPresence = serverId ? canonicalMembershipPresence(registry, "serverMemberships", serverMembershipKey(serverId, userId)) : undefined
  const anchor = parentChannelId ? channels.find((row) => row.id === parentChannelId) : channel
  const category = anchor?.categoryId ? collectionRows(registry, "categories").find((row) => row.id === anchor.categoryId && row.serverId === serverId) : undefined
  const publicAnchor = !!serverId && !!anchor && (anchor.categoryId === null || category?.private === false)
  const accessPresence = publicAnchor && serverPresence !== undefined ? serverPresence
    : parentChannelId ? relationPresence(parentChannelId, "access") : relationPresence(channelId, "access")
  const membership = channel?.type === "thread" || parentChannelId
    ? [relationPresence(channelId, "notify"), accessPresence]
    : [accessPresence, channel ? true : relationPresence(channelId, "notify")]
  if (serverId) membership.push(serverPresence)
  return membership.includes(false) ? false : membership.every((present) => present === true) ? true : undefined
}

function pruneCanonicalTypingMembership(registry: CommunityDbRegistry, completeRoster?: CompleteChannelRoster) {
  if (getCommunityDbRegistry(registry.queryClient) !== registry || !registry.runtime.lifecycle.get().active) return
  for (const [scopeKey, users] of registry.runtime.ui.get().typingByScope) {
    if (!scopeKey.startsWith("ch:") && !scopeKey.startsWith("dm:")) continue
    for (const userId of users.keys()) {
      if (getCanonicalCommunityTypingMembership(registry.queryClient, scopeKey.slice(3), userId, completeRoster) === false) {
        clearTypingIndicator(registry.queryClient, scopeKey, userId)
      }
    }
  }
}

function isProtectedFromQueryWrite(
  registry: CommunityDbRegistry,
  name: CollectionName,
  key: string,
) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  if (context?.kind !== "query") return false
  return (canonicalRevisionState(registry.queryClient).entityRevisions.get(
    canonicalEntityKey(name, key),
  ) ?? 0) > context.requestRevision
}

function recordEventWrites(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
  fields: readonly string[] = ["*"],
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    for (const field of fields) revisions.set(field, state.revision)
    state.fieldRevisions.set(entityKey, revisions)
   }
  })
}

function recordEventPatches<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
  patch: (row: T) => T,
  presentKeys: ReadonlySet<string>,
  fields: readonly string[] = ["*"],
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    for (const field of fields) revisions.set(field, state.revision)
    state.fieldRevisions.set(entityKey, revisions)
    if (presentKeys.has(key)) {
      state.pendingOperations.delete(entityKey)
      continue
    }
    const pending = [...(state.pendingOperations.get(entityKey) ?? [])]
    pending.push({
      revision: state.revision,
      kind: "patch",
      apply: patch as unknown as (row: object) => object,
    })
    state.pendingOperations.set(entityKey, pending)
   }
  })
}

function recordEventDeletes(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    revisions.set("*", state.revision)
    state.fieldRevisions.set(entityKey, revisions)
    state.pendingOperations.set(entityKey, [{
      revision: state.revision,
      kind: "delete",
    }])
   }
  })
}

function clearPendingOperations(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  updateCanonicalRevisions(registry.queryClient, (state) => {
    for (const key of keys) state.pendingOperations.delete(canonicalEntityKey(name, key))
  })
}

function mergePendingOperationsIntoQueryRow<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  key: string,
  schema: z.ZodType<T>,
  incoming: T,
) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  if (context?.kind !== "query") return incoming
  const operations = canonicalRevisionState(registry.queryClient).pendingOperations
    .get(canonicalEntityKey(name, key))
    ?.filter((operation) => operation.revision > context.requestRevision)
  if (!operations?.length) return undefined
  let next: object | undefined = incoming
  for (const operation of operations) {
    if (operation.kind === "delete") next = undefined
    else if (next) next = operation.apply(next)
  }
  if (!next) return undefined
  clearPendingOperations(registry, name, [key])
  return schema.parse(next)
}

function withCanonicalWriteContext<T>(
  queryClient: QueryClient,
  context: CanonicalWriteContext,
  publish: () => T,
) {
  const previous = canonicalWriteContexts.get(queryClient)
  canonicalWriteContexts.set(queryClient, context)
  try {
    return publish()
  } finally {
    if (previous) canonicalWriteContexts.set(queryClient, previous)
    else canonicalWriteContexts.delete(queryClient)
  }
}

function collectionSchema<N extends CollectionName>(name: N) {
  return communityCollectionSchemas[name] as unknown as z.ZodType<CommunityCollectionRows[N]>
}

function collectionRows<N extends CollectionName>(registry: CommunityDbRegistry, name: N): CommunityCollectionRows[N][] {
  const schema = collectionSchema(name)
  const values = registry.queryClient.getQueryData<unknown[]>(communityKeys.communityDbCollection(registry.scopeId, name))
    ?? Array.from<unknown>(registry.collections[name].values())
  return values.flatMap((row) => {
    const parsed = schema.safeParse(communityRowData(row))
    return parsed.success ? [parsed.data] : []
  })
}

function collectionKey<N extends CollectionName>(registry: CommunityDbRegistry, name: N) {
  const collection = registry.collections[name] as { getKeyFromItem: (row: CommunityCollectionRows[N]) => string }
  return (row: CommunityCollectionRows[N]) => collection.getKeyFromItem(row)
}

function replaceRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  incoming: CommunityCollectionRows[N][],
  owns: (row: CommunityCollectionRows[N]) => boolean,
  eventFields?: readonly string[],
) {
  if (!registry.restoration.get().captured && canonicalWriteContexts.get(registry.queryClient)?.kind === "query") {
    updateCanonicalRevisions(registry.queryClient, (state) => {
      state.restoreReplacements = [...state.restoreReplacements, { name, owns: owns as (row: object) => boolean }]
    })
  }
  const schema = collectionSchema(name)
  const getKey = collectionKey(registry, name)
  const parsedIncoming = incoming.map((row) => schema.parse(communityRowData(row)))
  const current = collectionRows(registry, name)
  const nextByKey = new Map(current.flatMap((row) => {
    const key = getKey(row)
    return !owns(row) || isProtectedFromQueryWrite(registry, name, key)
      ? [[key, row] as const]
      : []
  }))
  for (const row of parsedIncoming) {
    const key = getKey(row)
    if (!isProtectedFromQueryWrite(registry, name, key)) {
      nextByKey.set(key, row)
      clearPendingOperations(registry, name, [key])
      continue
    }
    if (nextByKey.has(key)) {
      const context = canonicalWriteContexts.get(registry.queryClient)
      const revisions = canonicalRevisionState(registry.queryClient).fieldRevisions.get(canonicalEntityKey(name, key))
      if (context?.kind === "query" && !Array.from(revisions?.values() ?? []).some(revision => revision > context.requestRevision)) nextByKey.set(key, row)
      clearPendingOperations(registry, name, [key])
      continue
    }
    const merged = mergePendingOperationsIntoQueryRow(registry, name, key, schema, row)
    if (merged) nextByKey.set(key, merged)
  }
  const next = [...nextByKey.values()]
  writeCommunityCollectionRows(registry, name, next, getKey)
  if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  if (name === "channels" || name === "categories") reconcileExistingServerDirectoryWindows(registry)
  recordEventWrites(registry, name, [
    ...current.filter(owns).map(getKey),
    ...parsedIncoming.map(getKey),
  ], eventFields)
  if (name === "channelMemberships" || name === "serverMemberships") pruneCanonicalTypingMembership(registry)
}

function upsertRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  incoming: CommunityCollectionRows[N][],
  eventFields?: readonly string[],
) {
  replaceRows(registry, name, incoming, () => false, eventFields)
}

export function discardCommunityRestoreReplacements(registry: CommunityDbRegistry) {
  updateCanonicalRevisions(registry.queryClient, (state) => { state.restoreReplacements = [] })
}

export async function restoreCommunityCollections(registry: CommunityDbRegistry, input: CommunityRestoredCollections) {
  const client = registry.queryClient
  const token = captureCommunityLiveSnapshotToken(client)
  assertCommunityLiveSnapshotTokenCurrent(client, token, undefined)
  const replacements = canonicalRevisionState(client).restoreReplacements
  const excluded = (name: CollectionName, row: object) => replacements.some((replacement) => replacement.name === name && replacement.owns(row))
  const currentServers = new Set(collectionRows(registry, "servers").map((row) => row.id))
  const currentChannels = new Map(collectionRows(registry, "channels").map((row) => [row.id, row]))
  const blockedServers = new Set((input.servers?.rows ?? []).filter((row) => !currentServers.has(row.id) && excluded("servers", row)).map((row) => row.id))
  const blockedChannels = new Set((input.channels?.rows ?? []).filter((row) => !currentChannels.has(row.id) && (excluded("channels", row) || !!row.serverId && blockedServers.has(row.serverId))).map((row) => row.id))
  const channels = new Map([...(input.channels?.rows ?? []).map((row) => [row.id, row] as const), ...currentChannels])
  const isRetiredChannel = (id: string) => {
    const channel = channels.get(id)
    return blockedChannels.has(id)
      || !!channel?.parentChannelId && blockedChannels.has(channel.parentChannelId)
      || registry.runtime.ws.actions.isChannelAccessRevoked(id, channel?.serverId, channel?.parentChannelId ?? undefined)
  }
  const eligible = (name: CollectionName, row: object) => {
    const fields = row as Record<string, unknown>
    const friendUserId = name === "friendships" ? fields.userId
      : name === "attentionItems" && fields.kind === "friend_request" ? fields.actorUserId : undefined
    if (typeof friendUserId === "string"
      && (canonicalRevisionState(client).entityRevisions.get(canonicalEntityKey("friendships", `user:${friendUserId}`)) ?? 0) > 0) return false
    if (typeof fields.serverId === "string" && (blockedServers.has(fields.serverId) || registry.runtime.ws.get().revokedServerIds.has(fields.serverId))) return false
    const channelIds = name === "channels" ? [fields.id] : [fields.channelId, fields.scopeId, fields.childChannelId,
      fields.readTarget && typeof fields.readTarget === "object" ? (fields.readTarget as { channelId?: unknown }).channelId : undefined]
    return !channelIds.some((id) => typeof id === "string" && isRetiredChannel(id))
  }
  const completions: Array<Promise<void> | undefined> = []
  const merge = <N extends CollectionName>(name: N) => {
    const restored = input[name]
    if (!restored) return
    const key = communityKeys.communityDbCollection(registry.scopeId, name)
    const state = client.getQueryState(key)
    const schema = collectionSchema(name)
    const getKey = collectionKey(registry, name)
    const next = new Map(collectionRows(registry, name).map((row) => [getKey(row), row]))
    for (const disk of restored.rows) {
      const row = disk as CommunityCollectionRows[N]
      const id = getKey(row)
      const current = next.get(id)
      if (!eligible(name, row)) continue
      if (current) {
        const present = Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined))
        const merged = state && state.dataUpdatedAt > 0 ? { ...row, ...present } : { ...present, ...row }
        if (name === "profiles") {
          const currentProfile = current as ProfileRow
          const diskProfile = row as ProfileRow
          const currentVersion = currentProfile.avatarVersion ?? -1
          const diskVersion = diskProfile.avatarVersion ?? -1
          const newer = currentVersion > diskVersion ? currentProfile : diskVersion > currentVersion ? diskProfile : undefined
          if (newer) Object.assign(merged, { avatar: newer.avatar, avatarVersion: newer.avatarVersion })
        }
        next.set(id, schema.parse(merged))
      } else if (!excluded(name, row)) {
        const merged = withCanonicalWriteContext(client, { kind: "query", requestRevision: 0, profileSnapshot: token.profileSnapshot }, () => (
          isProtectedFromQueryWrite(registry, name, id) ? mergePendingOperationsIntoQueryRow(registry, name, id, schema, row) : row
        ))
        if (merged) next.set(id, merged)
      }
    }
    completions.push(writeCommunityCollectionRows(registry, name, [...next.values()], getKey, { updatedAt: state && state.dataUpdatedAt > 0 ? state.dataUpdatedAt : restored.updatedAt }))
  }
  notifyManager.batch(() => {
    for (const name of Object.keys(input) as CollectionName[]) merge(name)
  })
  await Promise.all(completions)
  assertCommunityLiveSnapshotTokenCurrent(client, token, undefined)
}

function patchRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  patch: (row: CommunityCollectionRows[N]) => CommunityCollectionRows[N],
  matches: (row: CommunityCollectionRows[N]) => boolean,
  eventKeys?: Iterable<string>,
  eventFields?: readonly string[],
) {
  const schema = collectionSchema(name)
  const getKey = collectionKey(registry, name)
  const current = collectionRows(registry, name)
  let changed = false
  const changedKeys: string[] = []
  const next = current.map((row) => {
    if (!matches(row)) return row
    const key = getKey(row)
    if (isProtectedFromQueryWrite(registry, name, key)) return row
    changed = true
    changedKeys.push(key)
    return schema.parse(patch(row))
  })
  if (changed) {
    writeCommunityCollectionRows(registry, name, next, getKey)
    if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  if (name === "channels" || name === "categories") reconcileExistingServerDirectoryWindows(registry)
  }
  if (eventKeys) {
    recordEventPatches(registry, name, eventKeys, patch, new Set(changedKeys), eventFields)
  }
  else recordEventWrites(registry, name, changedKeys, eventFields)
  return changed
}

function deleteRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  remove: (row: CommunityCollectionRows[N]) => boolean,
  eventKeys?: Iterable<string>,
) {
  const getKey = collectionKey(registry, name)
  const current = collectionRows(registry, name)
  const removedKeys: string[] = []
  const next = current.filter((row) => {
    if (!remove(row)) return true
    const key = getKey(row)
    if (isProtectedFromQueryWrite(registry, name, key)) return true
    removedKeys.push(key)
    return false
  })
  writeCommunityCollectionRows(registry, name, next, getKey)
  if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  if (name === "channels" || name === "categories") reconcileExistingServerDirectoryWindows(registry)
  if (eventKeys) recordEventDeletes(registry, name, eventKeys)
  else recordEventWrites(registry, name, removedKeys)
  if (name === "channelMemberships" || name === "serverMemberships") pruneCanonicalTypingMembership(registry)
}

function referencedProfileIds(registry: CommunityDbRegistry) {
  const ids = new Set<string>(registry.accountId ? [registry.accountId] : [])
  for (const row of collectionRows(registry, "servers")) {
    if (row.ownerId) ids.add(row.ownerId)
  }
  for (const row of collectionRows(registry, "serverMemberships")) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "channelMemberships")) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "friendships")) ids.add(row.userId)
  for (const row of collectionRows(registry, "messages")) {
    for (const id of messageProfileIds(row as MessageRow & Msg)) ids.add(id)
  }
  return ids
}

function garbageCollectCommunityProfiles(registry: CommunityDbRegistry) {
  const referenced = referencedProfileIds(registry)
  deleteRows(
    registry,
    "profiles",
    (row) => !referenced.has(row.id),
  )
}

function pruneInboxCaches(
  queryClient: QueryClient,
  channelIds: ReadonlySet<string>,
  serverId: string | null,
) {
  queryClient.setQueryData<{
    friendRequests: unknown[]
    servers: Array<{
      serverId: string
      channels: Array<{ channelId: string; children: Array<{ channelId: string }> }>
    }>
    dms: Array<{ channelId: string }>
  } | undefined>(communityKeys.inboxUnreads(), (current) => {
    if (!current) return current
    const servers = current.servers.flatMap((server) => {
      if (serverId && server.serverId === serverId) return []
      const channels = server.channels.flatMap((channel) => {
        if (channelIds.has(channel.channelId)) return []
        const children = channel.children.filter((child) => !channelIds.has(child.channelId))
        return [{ ...channel, children }]
      })
      return channels.length > 0 ? [{ ...server, channels }] : []
    })
    return {
      ...current,
      servers,
      dms: current.dms.filter((dm) => !channelIds.has(dm.channelId)),
    }
  })
  queryClient.setQueryData<{
    mentions: Array<{ channelId?: string; serverId?: string }>
  } | undefined>(communityKeys.inboxMentions(), (current) => current ? {
    ...current,
    mentions: current.mentions.filter((entry) => (
      !entry.channelId || !channelIds.has(entry.channelId)
    ) && (!serverId || entry.serverId !== serverId)),
  } : current)
  queryClient.setQueryData<{
    marked: Array<{ channelId: string; serverId: string | null }>
  } | undefined>(communityKeys.inboxMarked(), (current) => current ? {
    ...current,
    marked: current.marked.filter((entry) => (
      !channelIds.has(entry.channelId) && (!serverId || entry.serverId !== serverId)
    )),
  } : current)
  void queryClient.invalidateQueries({
    queryKey: communityKeys.inbox(),
    refetchType: "active",
  })
}

function clearChannelTransientState(
  registry: CommunityDbRegistry,
  channelIds: ReadonlySet<string>,
  serverId: string | null,
  preserveQuery?: Query,
  options?: { queries?: ReadonlySet<Query>; assertView?: () => void },
) {
  const messageIds = new Set([
    ...takeMessageIdsForAccessScope(registry.queryClient, channelIds, serverId),
    ...collectionRows(registry, "messages")
      .filter((row) => channelIds.has(row.channelId))
      .map((row) => row.id),
  ])
  for (const messageId of messageIds) {
    void registry.queryClient.cancelQueries({
      queryKey: communityKeys.message(messageId),
      exact: true,
    })
    registry.queryClient.removeQueries({
      queryKey: communityKeys.message(messageId),
      exact: true,
    })
  }
  if (serverId) void registry.queryClient.invalidateQueries({ queryKey: communityKeys.forumSidebarThreads(serverId), exact: true })
  if (channelIds.size === 0) return
  for (const entry of registry.runtime.messageStream.get().entries.values()) {
    if (channelIds.has(entry.scope.id)) registry.runtime.messageStream.actions.removeScope(entry.scope)
  }
  const community = registry.runtime.ui.get()
  for (const channelId of channelIds) {
    for (const scope of [`ch:${channelId}`, `dm:${channelId}`]) {
      for (const userId of community.typingByScope.get(scope)?.keys() ?? []) {
        clearTypingIndicator(registry.queryClient, scope, userId)
      }
    }
  }
  pruneInboxCaches(registry.queryClient, channelIds, null)
  if (serverId) {
    const remembered = getLastChannel(serverId)
    if (remembered && channelIds.has(remembered)) clearLastChannel(serverId)
  } else {
    const remembered = getLastMeLeaf()
    if (remembered && channelIds.has(remembered)) clearLastMeLocation()
  }
  let viewCurrent = true
  try { options?.assertView?.() } catch { viewCurrent = false }
  if (viewCurrent && !preserveQuery && community.currentChannelId && channelIds.has(community.currentChannelId)) {
    registry.runtime.ui.actions.setCurrentChannelId(null)
  }
  const subscription = { ...community.subscription }
  if (subscription.channelId && channelIds.has(subscription.channelId)) delete subscription.channelId
  if (subscription.secondaryChannelId && channelIds.has(subscription.secondaryChannelId)) {
    delete subscription.secondaryChannelId
    registry.runtime.ui.setState((state) => ({ ...state, secondaryChannelOwner: null }))
  }
  if (subscription.dmConversationId && channelIds.has(subscription.dmConversationId)) {
    delete subscription.dmConversationId
  }
  registry.runtime.ui.setState((state) => ({ ...state, subscription }))
  if (community.pendingReply && channelIds.has(community.pendingReply.channelId)) {
    registry.runtime.ui.actions.setPendingReply(null)
  }
  const predicate = (query: Query) => {
    if (query === preserveQuery || options?.queries && !options.queries.has(query)) return false
    const key = query.queryKey
    if (key[0] !== "community" || key[1] === "db") return false
    if ((key[1] === "channel" || key[1] === "dm") && channelIds.has(String(key[2]))) return true
    if (key[1] === "message-context" && channelIds.has(String(key[3]))) return true
    if (key[1] === "servers" && (!serverId || key[2] === serverId) && (key[3] === "channel-meta" || key[3] === "forum-sidebar-retained") && channelIds.has(String(key[4]))) return true
    const data = query.state.data as { channelId?: unknown; scope?: { channelId?: unknown } } | undefined
    return typeof data?.channelId === "string" && channelIds.has(data.channelId)
      || typeof data?.scope?.channelId === "string" && channelIds.has(data.scope.channelId)
  }
  void registry.queryClient.cancelQueries({ predicate })
  registry.queryClient.removeQueries({ predicate })
}

export function ingestServers(
  registry: CommunityDbRegistry,
  response: ServersResponse,
) {
  const currentServers = collectionRows(registry, "servers")
  const incomingServerIds = new Set(response.servers.map((server) => server.id))
  const removedServerIds = currentServers
    .filter((server) => !incomingServerIds.has(server.id))
    .map((server) => server.id)
  const servers: ServerRow[] = response.servers.map((server, position) => serverSchema.parse({
    id: server.id, position, name: server.name, discriminator: server.discriminator,
    description: server.description, ownerId: server.ownerId, icon: server.icon, official: server.official, isOwner: server.isOwner,
  }))
  const viewerId = registry.accountId
  const memberships: ServerMembershipRow[] = viewerId ? response.servers.map(server => serverMembershipSchema.parse({
    id: serverMembershipKey(server.id, viewerId), serverId: server.id, userId: viewerId, memberId: server.memberId, role: server.role, viewer: true,
  })) : []
  notifyManager.batch(() => {
    for (const serverId of removedServerIds) if (!isOwnerServerDeleteScopeEvictionBlocked(registry.queryClient, serverId)) purgeCommunityServer(registry, serverId)
    replaceRows(registry, "servers", servers, (row) => !isOwnerServerDeleteScopeEvictionBlocked(registry.queryClient, row.id))
    if (viewerId) {
      replaceRows(
        registry,
        "serverMemberships",
        memberships,
        (row) => row.viewer,
      )
    }
  })
}

export function ingestServerDetail(
  registry: CommunityDbRegistry,
  input: ServerDirectorySnapshot,
) {
  const detail = ServerDirectorySnapshotSchema.parse(input)
  const serverId = detail.server.id
  if (detail.categories.some(row => row.serverId !== serverId)
    || detail.channels.some(row => row.serverId !== serverId || row.parentChannelId !== null
      || row.categoryId !== null && !detail.categories.some(category => category.id === row.categoryId))) throw new Error("Directory resource scope mismatch")
  const categories = detail.categories.map(row => ({ ...row, pending: false }))
  const channels = detail.channels.map(row => canonicalChannelRow({ ...row, pending: false }, registry.collections.channels.get(row.id)))
  const previousIds = collectionRows(registry, "channels").filter(row => row.serverId === serverId && row.parentChannelId === null).map(row => row.id)
  const nextIds = new Set(channels.map(row => row.id))
  notifyManager.batch(() => {
    for (const id of previousIds) if (!nextIds.has(id)) purgeCommunityChannel(registry, id)
    upsertRows(registry, "servers", [detail.server])
    replaceRows(registry, "categories", categories, row => row.serverId === serverId)
    replaceRows(registry, "channels", channels, row => row.serverId === serverId && row.parentChannelId === null)
    recordServerDirectoryWindow(registry, serverId)
  })
}

function ingestChannelMetadata(
  registry: CommunityDbRegistry,
  input: unknown,
  proof?: CommunityFreshQueryProof,
) {
  const metadata = CommunityChannelResourceSchema.strip().parse(input)
  const hints = channelLocalSchema.pick({ openerSeq: true, openerUnread: true }).strip().parse(input)
  const existing = registry.collections.channels.get(metadata.id)
  const sidebarKey = metadata.serverId ? communityKeys.forumSidebarThreads(metadata.serverId) : null
  const sidebar = sidebarKey && !registry.queryClient.getQueryState(sidebarKey)?.isInvalidated
    && readForumSidebarWindowResult(registry.queryClient.getQueryData(sidebarKey))
  const openerArchived = sidebar && sidebar.window.accountId === registry.accountId && sidebar.window.serverId === metadata.serverId
    && metadata.type === "thread" && metadata.parentChannelId !== null && sidebar.window.parents.includes(metadata.parentChannelId)
    && sidebar.window.retained?.id === metadata.id && sidebar.window.retained.disposition === "opener-archived"
  const changes = { ...metadata, ...hints, pending: false,
    ...(openerArchived ? { tags: [...new Set([...(existing?.tags ?? []), FORUM_ARCHIVE_TAG])] } : {}),
  }
  if (proof && existing) {
    publishConfirmedFields(registry.queryClient, "channels", metadata.id, changes, proof)
  } else {
    upsertRows(registry, "channels", [canonicalChannelRow(changes, existing)])
  }
}

export function ingestDms(
  registry: CommunityDbRegistry,
  response: DmsResponse,
  mode: SnapshotIngestMode = "authoritative",
) {
  const viewerId = registry.accountId
  if (!viewerId) return
  response = parseCommunityDmsRead(response, viewerId)
  const currentDmIds = new Set(
    collectionRows(registry, "channels")
      .filter((row) => row.type === "dm")
      .map((row) => row.id),
  )
  const channels: ChannelRow[] = []
  const memberships: ChannelMembershipRow[] = []
  const profilePatches: CommunityProfilePatch[] = []
  for (const dm of response.conversations) {
    const channel = CommunityChannelResourceSchema.parse(dm.channel)
    const profile = CommunityResourceProfileSchema.parse(dm.profile)
    if (channel.id !== dm.id || channel.type !== "dm" || profile.id !== dm.userId
      || dm.memberships.length !== 2 || !dm.memberships.every(row => row.channelId === dm.id && row.relation === "access")
      || !dm.memberships.some(row => row.userId === viewerId) || !dm.memberships.some(row => row.userId === dm.userId)) throw new Error("DM resource scope mismatch")
    channels.push(canonicalChannelRow({ ...channel, preview: dm.preview }, registry.collections.channels.get(dm.id)))
    memberships.push(...dm.memberships.map(row => canonicalChannelMembershipRow(row.channelId, row.userId, row.relation, {
      source: row.source,
    })))
    profilePatches.push(communityUserProfilePatch(profile.id, profile))
  }
  const dmIds = new Set(channels.map((row) => row.id))
  const authoritativeDmIds = new Set([...currentDmIds, ...dmIds])
  const removedDmIds = [...currentDmIds].filter((channelId) => !dmIds.has(channelId))
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      for (const channelId of removedDmIds) purgeCommunityChannel(registry, channelId)
      replaceRows(registry, "channels", channels, (row) => row.type === "dm")
      replaceRows(
        registry,
        "channelMemberships",
        memberships,
        (row) => row.relation === "access" && authoritativeDmIds.has(row.channelId),
      )
    } else {
      upsertRows(registry, "channels", channels)
      upsertRows(
        registry,
        "channelMemberships",
        memberships,
      )
    }
    writeCanonicalProfilePatches(registry, profilePatches)
  })
}

/**
 * Projects one locally confirmed DM summary before navigation. This is an
 * additive event write: it cannot remove sibling conversations, and its
 * revision fence prevents an older in-flight `/dms` snapshot from deleting
 * the destination before the route mounts.
 */
export function publishCommunityDmSummary(
  queryClient: QueryClient,
  dm: DM,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    const previous = registry.collections.channels.get(dm.id)
    if (!previous || previous.type !== "dm") return "missing-resource" as const
    upsertRows(registry, "channels", [canonicalChannelRow({ ...previous, preview: dm.preview })])
    return "published" as const
  })
}

function ingestFolders(
  registry: CommunityDbRegistry,
  response: FoldersResponse,
) {
  const folders: FolderRow[] = response.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
  }))
  const items: FolderItemRow[] = response.folders.flatMap((folder) => (
    folder.servers.map((server, position) => ({
      id: folderItemKey(folder.id, server.id),
      folderId: folder.id,
      serverId: server.id,
      position,
    }))
  ))
  notifyManager.batch(() => {
    if (Object.hasOwn(response, "topOrder")) replaceRows(registry, "serverRail", response.topOrder ? [{ id: "account", entries: response.topOrder }] : [], () => true)
    replaceRows(registry, "folders", folders, () => true)
    replaceRows(registry, "folderItems", items, () => true)
  })
}

export function publishCommunityServerRailCommit(queryClient: QueryClient, projection: ServerRailProjection, proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    if (projection.reorderTopLevel) replaceRows(registry, "serverRail", [{ id: "account", entries: serverRailTopOrder(projection.after) }], () => true)
    const affected = new Set([...projection.affectedFolderIds, ...projection.createdFolders.map((row) => row.id)])
    const folders = projection.after.folderIds.filter((id) => affected.has(id)).map((id) => ({ id, name: projection.after.folders[id]!.name }))
    const knownServers = new Set(collectionRows(registry, "servers").map((row) => row.id))
    const allowed = new Set(collectionRows(registry, "serverMemberships").filter((row) => row.viewer && row.userId === registry.accountId && knownServers.has(row.serverId)).map((row) => row.serverId))
    const items = folders.flatMap((folder) => projection.after.folders[folder.id]!.serverIds.filter((serverId) => allowed.has(serverId)).map((serverId, position) => ({ id: folderItemKey(folder.id, serverId), folderId: folder.id, serverId, position })))
    notifyManager.batch(() => {
      replaceRows(registry, "folders", folders, (row) => affected.has(row.id))
      replaceRows(registry, "folderItems", items, (row) => affected.has(row.folderId))
    })
    return "published" as const
  })
}

function effectiveMessageResource(registry: CommunityDbRegistry, resource: CommunityMessageResource) {
  const previous = registry.collections.messages.status === "ready" ? registry.collections.messages.get(resource.id)
    : registry.queryClient.getQueryData<MessageRow[]>(communityKeys.communityDbCollection(registry.scopeId, "messages"))?.find(message => message.id === resource.id)
  const retainReply = previous?.channelId === resource.channelId
    && previous.authorId === resource.authorId && previous.clientNonce === resource.clientNonce
    && previous.replyToId === resource.replyToId && resource.replyToId !== null && !("replyTo" in resource)
  return messageSchema.parse({ ...resource, ...(retainReply && previous.replyTo ? { replyTo: previous.replyTo } : {}) })
}

export function getCanonicalCommunityMessageResources(queryClient: QueryClient, messages: readonly unknown[]) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return
  const parsed = CommunityMessageResourceSchema.strip().array().safeParse(messages)
  if (!parsed.success) return
  const currentProfiles = new Map(collectionRows(registry, "profiles").map(profile => [profile.id, profile]))
  const profiles = communityMessageProfileIds(parsed.data).flatMap(id => {
    const profile = CommunityResourceProfileSchema.strip().safeParse(currentProfiles.get(id))
    return profile.success ? [profile.data] : []
  })
  const graph = CommunityMessageResourcesSchema.safeParse({ messages: parsed.data, profiles })
  return graph.success ? graph.data : undefined
}

export function validateCommunityMessagePublication(registry: CommunityDbRegistry, messages: readonly unknown[], profiles: readonly CommunityResourceProfile[]) {
  const graph = CommunityMessageResourcesSchema.parse({ messages, profiles })
  const retained = graph.messages.map(message => effectiveMessageResource(registry, message))
  const currentProfiles = new Map(collectionRows(registry, "profiles").map(profile => [profile.id, profile]))
  const available = new Map(communityMessageProfileIds(retained).flatMap(id => {
    const profile = CommunityResourceProfileSchema.strip().safeParse(currentProfiles.get(id))
    return profile.success ? [[id, profile.data] as const] : []
  }))
  for (const profile of graph.profiles) available.set(profile.id, profile)
  if (!CommunityMessageResourcesSchema.safeParse({ messages: retained, profiles: [...available.values()] }).success) throw new Error("Retained message profile resource missing")
  return graph
}

export function ingestMessages(
  registry: CommunityDbRegistry,
  channelId: string,
  messages: readonly unknown[],
  profiles: readonly CommunityResourceProfile[] = [],
) {
  const fullProfiles = new Map(profiles.map(profile => { const parsed = CommunityResourceProfileSchema.parse(profile); return [parsed.id, parsed] as const }))
  const resources = messages.map(message => {
      const resource = CommunityMessageResourceSchema.parse(message)
      if (resource.channelId !== channelId) throw new Error("Message channel mismatch")
      return resource
    })
  const rows = resources.map(resource => effectiveMessageResource(registry, resource))
  upsertRows(registry, "messages", rows)
  for (const resource of resources) {
    const thread = resource.thread
    const previous = thread && registry.collections.channels.get(thread.id)
    if (!thread || !previous || !CommunityChannelResourceSchema.strip().safeParse(previous).success) continue
    upsertRows(registry, "channels", [canonicalChannelRow({ ...previous,
      name: thread.name, messageCount: thread.messageCount,
      ...(thread.lastReplyAt === undefined ? {} : { lastMessageAt: thread.lastReplyAt }),
      ...(thread.tags === undefined ? {} : { tags: thread.tags }),
      ...(thread.preview === undefined ? {} : { preview: thread.preview }),
      ...(thread.participantCount === undefined ? {} : { participantCount: thread.participantCount }),
    })])
  }
  writeCanonicalProfilePatches(registry, messageProfilePatches(resources).filter(patch => {
    const previous = registry.collections.profiles.get(patch.id)
    return previous !== undefined && CommunityResourceProfileSchema.strip().safeParse(previous).success
  }).map(patch => {
    const full = fullProfiles.get(patch.id)
    if (!full) return patch
    const hints = { ...patch }
    delete hints.identityAbout
    if (hints.avatar && hints.avatar.avatarVersion <= full.avatarVersion) delete hints.avatar
    return hints
  }), canonicalWriteContexts.get(registry.queryClient)?.kind === "event")
}

export function ingestReadStateSnapshot(
  registry: CommunityDbRegistry,
  snapshot: AccountReadStateSnapshot,
) {
  const previousReads = new Map(collectionRows(registry, "readStates").map(row => [row.channelId, row.lastReadSeq]))
  const currentRevision = collectionRows(registry, "readStateClock")
    .find((row) => row.id === "account")?.revision ?? -1
  if (snapshot.revision <= currentRevision) return
  const newer = collectionRows(registry, "readStates").filter((row) => (row.observedRevision ?? -1) > snapshot.revision)
  const newerIds = new Set(newer.map((row) => row.channelId))
  const readStates: ReadStateRow[] = [
    ...snapshot.readStates.filter((row) => !newerIds.has(row.channelId)).map((row) => ({ ...row, observedRevision: snapshot.revision })),
    ...newer,
  ]
  const clock: ReadStateClockRow = { id: "account", revision: snapshot.revision }
  const nextReadSeq = new Map(readStates.map(row => [row.channelId, row.lastReadSeq]))
  const changedReads = new Set([...previousReads.keys(), ...nextReadSeq.keys()].filter(id => previousReads.get(id) !== nextReadSeq.get(id)))
  notifyManager.batch(() => {
    replaceRows(registry, "readStates", readStates, () => true)
    replaceRows(registry, "readStateClock", [clock], () => true)
    projectConfirmedAttention(registry, changedReads)
  })
}

export function publishCommunityConversationReadState(
  queryClient: QueryClient,
  readState: ReadStateRow,
  revision: number,
  proof: CommunityFreshQueryProof,
  mode: "snapshot" | "advance" = "snapshot",
) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    const clock = collectionRows(registry, "readStateClock").find((row) => row.id === "account")?.revision ?? -1
    const current = collectionRows(registry, "readStates").find((row) => row.channelId === readState.channelId)
    if (clock > revision || (current?.observedRevision ?? -1) > revision
      || (mode === "snapshot" ? (current?.observedRevision ?? -1) === revision : (current?.lastReadSeq ?? -1) >= readState.lastReadSeq)) return "superseded" as const
    upsertRows(registry, "readStates", [{ ...readState, observedRevision: revision }])
    projectConfirmedAttention(registry, new Set([readState.channelId]))
    return "published" as const
  })
}

export function publishCommunityResourceBundle(queryClient: QueryClient, resources: CommunityResourceBundle, proof: CommunityFreshQueryProof,
  messageReferences?: readonly { id: string; channelId: string }[]) {
  return withCommunityQueryProof(queryClient, proof, registry => {
    const bundle = CommunityResourceBundleSchema.parse(resources)
    if (messageReferences && (new Set(messageReferences.map(row => row.id)).size !== messageReferences.length
      || bundle.messages.length !== messageReferences.length
      || messageReferences.some(ref => !bundle.messages.some(message => message.id === ref.id && message.channelId === ref.channelId)))) {
      throw new ZodError([{ code: "custom", path: ["messages"], message: "Message window resource closure mismatch" }])
    }
    return ingestCommunityResources(registry, bundle)
  })
}

function ingestCommunityResources(registry: CommunityDbRegistry, input: CommunityResourceBundle) {
  const resources = CommunityResourceBundleSchema.parse(input)
  if (resources.viewerId !== registry.accountId) throw new Error("Attention account mismatch")
  validateCommunityMessagePublication(registry, resources.messages, resources.profiles)
  for (const server of resources.servers) registry.runtime.ws.actions.grantServerAccess(server.id)
  for (const channel of resources.channels) registry.runtime.ws.actions.rememberChannelAccess(channel.serverId, channel.id, channel.parentChannelId ?? undefined)
  upsertRows(registry, "servers", resources.servers)
  upsertRows(registry, "serverMemberships", resources.serverMemberships.map(row => ({
    ...registry.collections.serverMemberships.get(serverMembershipKey(row.serverId, row.userId)),
    ...row, id: serverMembershipKey(row.serverId, row.userId), viewer: true,
  })))
  upsertRows(registry, "channels", resources.channels.map(row => canonicalChannelRow(row, registry.collections.channels.get(row.id))))
  upsertRows(registry, "channelMemberships", resources.memberships.map(row => canonicalChannelMembershipRow(row.channelId, row.userId, row.relation, { source: row.source })))
  writeCanonicalProfilePatches(registry, resources.profiles.map(row => communityUserProfilePatch(row.id, row)))
  for (const channel of resources.channels) ingestMessages(registry, channel.id, resources.messages.filter(row => row.channelId === channel.id), resources.profiles)
}

export type AttentionDomain = "channels" | "dms" | "mentions"
type AttentionFloor = {
  throughSeq: number
  clearedCount: number
  domain: "channels" | "dms"
  ordinary: boolean
  mentions: boolean
}
export type AttentionIntent = {
  token: symbol
  generation: number
  scopesQuery: Query | undefined
  itemsQuery: Query | undefined
  floors: ReadonlyMap<string, AttentionFloor>
  itemIds: ReadonlySet<string>
  itemDomains: ReadonlyMap<string, AttentionDomain>
  scopeId?: string
  targetSeq?: number
  clearedAttentionCount: number
  outcome: Promise<ReadonlySet<AttentionDomain> | undefined>
  resolveOutcome: (domains: ReadonlySet<AttentionDomain> | undefined) => void
  settled: Promise<boolean>
  resolveSettled: (success: boolean) => void
}
type AttentionTransaction = Transaction<Record<string, unknown>>
type AttentionTransactionState = {
  intents: ReadonlyMap<symbol, AttentionIntent>
  transactions: ReadonlyMap<symbol, AttentionTransaction>
  rebasing: boolean
  preload: Promise<void> | null
}
const attentionTransactionStores = new WeakMap<CommunityDbRegistry, ReturnType<typeof createStore<AttentionTransactionState>>>()

function attentionTransactionStore(registry: CommunityDbRegistry) {
  let store = attentionTransactionStores.get(registry)
  if (store) return store
  store = createStore<AttentionTransactionState>({ intents: new Map(), transactions: new Map(), rebasing: false, preload: null })
  attentionTransactionStores.set(registry, store)
  const original = store
  const unsubscribe = registry.queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "removed" && (event.type !== "updated" || event.action.type !== "success")) return
    if (original.get().intents.size === 0) return
    const key = event.query.queryKey
    if (JSON.stringify(key) !== JSON.stringify(communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"))
      && JSON.stringify(key) !== JSON.stringify(communityKeys.communityDbCollection(registry.scopeId, "attentionItems"))) return
    if (!original.get().rebasing) queueMicrotask(() => rebaseAttentionTransactions(registry))
  })
  const retire = registry.runtime.lifecycle.subscribe(() => {
    if (registry.runtime.lifecycle.get().active) return
    for (const intent of original.get().intents.values()) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
    original.setState((state) => ({ ...state, rebasing: true, intents: new Map() }))
    for (const transaction of original.get().transactions.values()) if (transaction.state !== "completed" && transaction.state !== "failed") transaction.rollback({ isSecondaryRollback: true })
    original.setState(() => ({ intents: new Map(), transactions: new Map(), rebasing: false, preload: null }))
    attentionTransactionStores.delete(registry)
    unsubscribe()
    retire.unsubscribe()
  })
  return store
}

function attentionIntentActive(registry: CommunityDbRegistry, intent: AttentionIntent) {
  const lifecycle = registry.runtime.lifecycle.get()
  return lifecycle.active && lifecycle.generation === intent.generation
    && getCommunityDbRegistry(registry.queryClient) === registry
    && registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"), exact: true }) === intent.scopesQuery
    && registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionItems"), exact: true }) === intent.itemsQuery
}

function confirmedAttentionProjection(registry: CommunityDbRegistry, scopes: AttentionScopeRow[], items: AttentionItemRow[], changedReads: ReadonlySet<string> = new Set()) {
  const readSeq = new Map(collectionRows(registry, "readStates").map((row) => [row.channelId, row.lastReadSeq]))
  const scopeById = new Map(scopes.map((scope) => [scope.scopeId, scope]))
  const messages = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const removedByScope = new Map<string, number>()
  const survivingByScope = new Map<string, number>()
  const nextItems = items.filter((item) => {
    if (item.kind === "friend_request") return true
    const scope = item.scopeId ? scopeById.get(item.scopeId) : undefined
    const message = item.messageId ? messages.get(item.messageId) : undefined
    const channelId = item.readTarget?.channelId ?? scope?.channelId
    const seq = item.readTarget?.seq ?? (message?.channelId === channelId ? message?.seq : undefined)
    const floor = channelId ? readSeq.get(channelId) : undefined
    const removed = seq !== undefined && floor !== undefined && seq <= floor
    if (item.scopeId && (item.kind === "mention" || item.kind === "reply")) {
      const counts = removed ? removedByScope : survivingByScope
      counts.set(item.scopeId, (counts.get(item.scopeId) ?? 0) + 1)
    }
    return !removed
  })
  const nextScopes = scopes.flatMap((scope): AttentionScopeRow[] => {
    const floor = readSeq.get(scope.channelId)
    if (floor === undefined) return [changedReads.has(scope.channelId) ? { ...scope, unreadCount: undefined } : scope]
    const ordinaryUnread = scope.ordinaryUnread && scope.lastUnreadSeq > floor
    const remaining = scope.lastAttentionSeq != null && scope.lastAttentionSeq <= floor
      ? 0
      : Math.max(0, scope.attentionCount - (removedByScope.get(scope.scopeId) ?? 0))
    const attentionCount = Math.min(scope.attentionCount, Math.max(remaining, survivingByScope.get(scope.scopeId) ?? 0))
    if (!ordinaryUnread && attentionCount === 0) return []
    return [{ ...scope, ordinaryUnread, attentionCount, ...(changedReads.has(scope.channelId) ? { unreadCount: undefined } : {}), lastAttentionSeq: attentionCount === 0 ? null : scope.lastAttentionSeq }]
  })
  return { scopes: nextScopes, items: nextItems }
}

function writeAttentionProjection(registry: CommunityDbRegistry, scopes: AttentionScopeRow[], items: AttentionItemRow[], projected: ReturnType<typeof confirmedAttentionProjection>) {
  const nextScopes = new Map(projected.scopes.map((scope) => [scope.scopeId, scope]))
  const previousScopes = new Map(scopes.map((scope) => [scope.scopeId, scope]))
  const nextItems = new Set(projected.items.map((item) => item.id))
  const removedScopes = new Set(scopes.filter((scope) => !nextScopes.has(scope.scopeId)).map((scope) => scope.scopeId))
  const removedItems = new Set(items.filter((item) => !nextItems.has(item.id)).map((item) => item.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => {
    if (removedScopes.size) deleteRows(registry, "attentionScopes", (row) => removedScopes.has(row.scopeId))
    upsertRows(registry, "attentionScopes", projected.scopes.filter((scope) => JSON.stringify(scope) !== JSON.stringify(previousScopes.get(scope.scopeId))))
    if (removedItems.size) deleteRows(registry, "attentionItems", (row) => removedItems.has(row.id))
  })
  return { nextScopes, previousScopes }
}

function projectConfirmedAttention(registry: CommunityDbRegistry, changedReads: ReadonlySet<string> = new Set()) {
  notifyManager.batch(() => {
    const scopes = collectionRows(registry, "attentionScopes")
    const items = collectionRows(registry, "attentionItems")
    writeAttentionProjection(registry, scopes, items, confirmedAttentionProjection(registry, scopes, items, changedReads))
  })
}

function attentionProjection(
  registry: CommunityDbRegistry,
  scopes: AttentionScopeRow[],
  items: AttentionItemRow[],
  intents: Iterable<AttentionIntent>,
) {
  const confirmed = confirmedAttentionProjection(registry, scopes, items)
  scopes = confirmed.scopes
  items = confirmed.items
  const readSeqs = new Map(collectionRows(registry, "readStates").map(row => [row.channelId, row.lastReadSeq]))
  const floors = new Map<string, { ordinary: number; mentions: number; cleared: number }>()
  const itemIds = new Set<string>()
  for (const intent of intents) {
    for (const id of intent.itemIds) itemIds.add(id)
    for (const [id, floor] of intent.floors) {
      const previous = floors.get(id) ?? { ordinary: -1, mentions: -1, cleared: 0 }
      floors.set(id, {
        ordinary: floor.ordinary ? Math.max(previous.ordinary, floor.throughSeq) : previous.ordinary,
        mentions: floor.mentions ? Math.max(previous.mentions, floor.throughSeq) : previous.mentions,
        cleared: floor.mentions ? Math.max(previous.cleared, floor.clearedCount) : previous.cleared,
      })
    }
  }
  const messages = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const seqOf = (item: AttentionItemRow) => item.readTarget?.seq ?? item.openerSeq ?? (item.messageId ? messages.get(item.messageId)?.seq : undefined)
  const removedByScope = new Map<string, number>()
  const survivingByScope = new Map<string, number>()
  const nextItems = items.filter((item) => {
    const floor = item.scopeId ? floors.get(item.scopeId) : undefined
    const seq = seqOf(item)
    const read = floor && (seq !== undefined ? seq <= floor.mentions : floor.mentions >= 0 && itemIds.has(item.id))
    const removed = itemIds.has(item.id) || read
    if (item.scopeId && (item.kind === "mention" || item.kind === "reply")) {
      if (removed && !read) removedByScope.set(item.scopeId, (removedByScope.get(item.scopeId) ?? 0) + 1)
      if (!removed) survivingByScope.set(item.scopeId, (survivingByScope.get(item.scopeId) ?? 0) + 1)
    }
    return !removed
  })
  const nextScopes = scopes.flatMap((scope): AttentionScopeRow[] => {
    const floor = floors.get(scope.scopeId)
    const ordinaryUnread = scope.ordinaryUnread && (!floor || scope.lastUnreadSeq > floor.ordinary)
    const lastAttentionSeq = floor && (scope.lastAttentionSeq ?? -1) <= floor.mentions ? null : scope.lastAttentionSeq
    const cleared = floor?.mentions !== undefined && floor.mentions >= 0 ? floor.cleared : 0
    const remaining = lastAttentionSeq === null ? 0 : Math.max(
      survivingByScope.get(scope.scopeId) ?? 0,
      scope.attentionCount - cleared,
    )
    const attentionCount = Math.max(0, Math.min(scope.attentionCount, remaining) - (removedByScope.get(scope.scopeId) ?? 0))
    if (!ordinaryUnread && attentionCount === 0) return []
    return [{ ...scope, ordinaryUnread, ...(floor && floor.ordinary > (readSeqs.get(scope.channelId) ?? -1) ? { unreadCount: undefined } : {}), lastAttentionSeq: attentionCount === 0 ? null : lastAttentionSeq, attentionCount }]
  })
  return { scopes: nextScopes, items: nextItems }
}

function rebaseAttentionTransactions(registry: CommunityDbRegistry) {
  const store = attentionTransactionStores.get(registry)
  if (!store || store.get().rebasing) return
  store.setState((state) => ({ ...state, rebasing: true }))
  try {
    const terminal = new Set<symbol>()
    for (const [token, transaction] of store.get().transactions) {
      if (transaction.state === "completed" || transaction.state === "failed") {
        terminal.add(token)
        store.get().intents.get(token)?.resolveSettled(transaction.state === "completed")
      } else transaction.rollback({ isSecondaryRollback: true })
    }
    const intents = new Map([...store.get().intents].filter(([token, intent]) => !terminal.has(token) && attentionIntentActive(registry, intent)))
    for (const [token, intent] of store.get().intents) if (!intents.has(token) && !terminal.has(token)) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
    const transactions = new Map<symbol, AttentionTransaction>()
    store.setState((state) => ({ ...state, intents, transactions }))
    if (registry.collections.attentionScopes.status !== "ready" || registry.collections.attentionItems.status !== "ready") {
      if (!store.get().preload && intents.size > 0) {
        const original = store
        const preload = Promise.all([registry.collections.attentionScopes.preload(), registry.collections.attentionItems.preload()]).then(() => {
          if (attentionTransactionStores.get(registry) !== original) return
          original.setState((state) => ({ ...state, preload: null }))
          rebaseAttentionTransactions(registry)
        }, () => {
          if (attentionTransactionStores.get(registry) !== original) return
          for (const intent of original.get().intents.values()) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
          original.setState((state) => ({ ...state, intents: new Map(), transactions: new Map(), preload: null }))
        })
        original.setState((state) => ({ ...state, preload }))
      }
      return
    }
    const scopes = collectionRows(registry, "attentionScopes")
    const items = collectionRows(registry, "attentionItems")
    const prefix: AttentionIntent[] = []
    for (const intent of intents.values()) {
      prefix.push(intent)
      const projected = attentionProjection(registry, scopes, items, prefix)
      const persist = async () => {
        const committed = await intent.outcome
        if (!committed || store.get().transactions.get(intent.token) !== transaction || !attentionIntentActive(registry, intent)) return
        store.setState((state) => ({ ...state, rebasing: true }))
        try { publishAttentionConfirmation(registry, store.get().intents.get(intent.token) ?? intent, committed) }
        catch {
          transaction.rollback({ isSecondaryRollback: true })
          finishAttentionTransaction(registry, intent, transaction, false)
        } finally { store.setState((state) => ({ ...state, rebasing: false })) }
      }
      const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      void transaction.when("settled").catch(() => undefined)
      transaction.mutate(() => {
        const nextScopes = new Map(projected.scopes.map((scope) => [scope.scopeId, scope]))
        for (const scope of registry.collections.attentionScopes.values()) {
          const next = nextScopes.get(scope.scopeId)
          if (!next) registry.collections.attentionScopes.delete(scope.scopeId)
          else if (Object.entries(next).some(([key, value]) => (scope as unknown as Record<string, unknown>)[key] !== value)) registry.collections.attentionScopes.update(scope.scopeId, (draft) => Object.assign(draft, next))
        }
        const nextIds = new Set(projected.items.map((item) => item.id))
        for (const item of registry.collections.attentionItems.values()) if (!nextIds.has(item.id)) registry.collections.attentionItems.delete(item.id)
      })
      transactions.set(intent.token, transaction)
    }
    store.setState((state) => ({ ...state, transactions }))
    for (const intent of intents.values()) {
      const transaction = transactions.get(intent.token)!
      if (transaction.mutations.length > 0) {
        void transaction.commit().then(() => finishAttentionTransaction(registry, intent, transaction, transaction.state === "completed"), () => finishAttentionTransaction(registry, intent, transaction, false))
      } else {
        void intent.outcome.then((committed) => {
          if (!committed || store.get().transactions.get(intent.token) !== transaction || !attentionIntentActive(registry, intent)) return
          store.setState((state) => ({ ...state, rebasing: true }))
          try { publishAttentionConfirmation(registry, store.get().intents.get(intent.token) ?? intent, committed) }
          finally { store.setState((state) => ({ ...state, rebasing: false })) }
          return transaction.commit().then(() => finishAttentionTransaction(registry, intent, transaction, true))
        }).catch(() => finishAttentionTransaction(registry, intent, transaction, false))
      }
    }
  } finally {
    store.setState((state) => ({ ...state, rebasing: false }))
  }
}

function beginAttentionIntent(registry: CommunityDbRegistry, values: Pick<AttentionIntent, "floors" | "itemIds" | "itemDomains" | "scopeId" | "targetSeq" | "clearedAttentionCount">) {
  const store = attentionTransactionStore(registry)
  let resolveOutcome!: AttentionIntent["resolveOutcome"], resolveSettled!: AttentionIntent["resolveSettled"]
  const outcome = new Promise<ReadonlySet<AttentionDomain> | undefined>((resolve) => { resolveOutcome = resolve })
  const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve })
  const intent: AttentionIntent = {
    ...values, outcome, resolveOutcome, settled, resolveSettled, token: Symbol("attention-command"), generation: registry.runtime.lifecycle.get().generation,
    scopesQuery: registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"), exact: true }),
    itemsQuery: registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionItems"), exact: true }),
  }
  notifyManager.batch(() => {
    store.setState((state) => ({ ...state, intents: new Map(state.intents).set(intent.token, intent) }))
    rebaseAttentionTransactions(registry)
  })
  return intent
}

function publishAttentionConfirmation(registry: CommunityDbRegistry, current: AttentionIntent, committed: ReadonlySet<AttentionDomain>) {
  const floors = new Map([...current.floors].map(([id, floor]) => [id, {
    ...floor,
    ordinary: floor.ordinary && committed.has(floor.domain),
    mentions: floor.mentions && committed.has(floor.domain === "dms" ? "dms" : "mentions"),
  }]))
  const confirmed = { ...current, floors, itemIds: new Set([...current.itemIds].filter((id) => committed.has(current.itemDomains.get(id) ?? "mentions"))) }
  const scopes = collectionRows(registry, "attentionScopes")
  const items = collectionRows(registry, "attentionItems")
  const projected = attentionProjection(registry, scopes, items, [confirmed])
  const { nextScopes, previousScopes } = writeAttentionProjection(registry, scopes, items, projected)
  const store = attentionTransactionStores.get(registry)
  store?.setState((state) => ({ ...state, intents: new Map([...state.intents].map(([token, intent]) => {
    if (token === current.token) return [token, intent]
    const remaining = new Map([...intent.floors].map(([id, floor]) => {
      const applied = floors.get(id)
      if (!applied?.mentions || !floor.mentions) return [id, floor]
      const removed = Math.max(0, (previousScopes.get(id)?.attentionCount ?? 0) - (nextScopes.get(id)?.attentionCount ?? 0))
      return [id, { ...floor, clearedCount: applied.throughSeq >= floor.throughSeq ? 0 : Math.max(0, floor.clearedCount - removed) }]
    }))
    return [token, { ...intent, floors: remaining }]
  })) }))
}

function finishAttentionTransaction(registry: CommunityDbRegistry, intent: AttentionIntent, transaction: AttentionTransaction, success: boolean) {
  const store = attentionTransactionStores.get(registry)
  if (!store || store.get().transactions.get(intent.token) !== transaction) return
  notifyManager.batch(() => {
    store.setState((state) => {
      const intents = new Map(state.intents), transactions = new Map(state.transactions)
      intents.delete(intent.token)
      transactions.delete(intent.token)
      return { ...state, intents, transactions }
    })
    intent.resolveSettled(success)
    rebaseAttentionTransactions(registry)
  })
}

function settleAttentionIntent(registry: CommunityDbRegistry, intent: AttentionIntent, committed?: ReadonlySet<AttentionDomain>) {
  const store = attentionTransactionStores.get(registry)
  const current = store?.get().intents.get(intent.token)
  if (!store || !current || !attentionIntentActive(registry, current)) { intent.resolveSettled(false); return false }
  if (committed) {
    current.resolveOutcome(committed)
    return true
  }
  const transaction = store.get().transactions.get(intent.token)
  if (transaction?.state === "completed" || transaction?.state === "failed") {
    finishAttentionTransaction(registry, current, transaction, transaction.state === "completed")
    return false
  }
  const superseded = current.scopeId && [...store.get().intents.values()].some((other) => other.token !== current.token && other.scopeId === current.scopeId && (other.targetSeq ?? -1) >= (current.targetSeq ?? -1))
  notifyManager.batch(() => {
    store.setState((state) => ({ ...state, rebasing: true }))
    try {
      store.get().transactions.get(intent.token)?.rollback({ isSecondaryRollback: true })
      store.setState((state) => {
        const intents = new Map(state.intents), transactions = new Map(state.transactions)
        intents.delete(intent.token)
        transactions.delete(intent.token)
        return { ...state, intents, transactions }
      })
      current.resolveOutcome(undefined)
      current.resolveSettled(false)
    } finally { store.setState((state) => ({ ...state, rebasing: false })) }
    rebaseAttentionTransactions(registry)
  })
  return !superseded
}

export function hasAttentionScopeOptimisticFence(queryClient: QueryClient, scopeId: string, targetSeq: number) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return [...(attentionTransactionStores.get(registry)?.get().intents.values() ?? [])]
    .some((intent) => intent.scopeId === scopeId && (intent.targetSeq ?? -1) >= targetSeq)
}

export function ingestAttentionSnapshot(registry: CommunityDbRegistry, snapshot: AccountAttentionSnapshot) {
  const included = AttentionIncludedSchema.parse(snapshot.included)
  const resources = CommunityResourceBundleSchema.parse(snapshot.resources)
  const channels = new Map(resources.channels.map(channel => [channel.id, channel]))
  if (included.dms.some(dm => channels.get(dm.id)?.type !== "dm" || dm.userId === resources.viewerId || !resources.profiles.some(profile => profile.id === dm.userId))
    || included.channels.some(summary => {
      const channel = channels.get(summary.id)
      return !channel || channel.serverId !== summary.serverId || channel.type !== summary.type
        || channel.parentChannelId !== summary.parentChannelId || channel.parentMessageId !== summary.parentMessageId
    })) throw new Error("Attention presentation resource mismatch")
  const openerHints = new Map(included.channels.flatMap(channel => channel.openerSeq === undefined && channel.openerUnread === undefined ? [] : [[channel.id, {
    ...(channel.openerSeq === undefined ? {} : { openerSeq: channel.openerSeq }),
    ...(channel.openerUnread === undefined ? {} : { openerUnread: channel.openerUnread }),
  }] as const]))
  notifyManager.batch(() => {
    const pending = collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" && row.needsOwnerApproval == null)
    const blocked = new Set(collectionRows(registry, "friendships").filter((row) => row.kind === "blocked").map((row) => row.userId))
    ingestCommunityResources(registry, resources)
    upsertRows(registry, "channelMemberships", included.dms.map(dm => canonicalChannelMembershipRow(dm.id, dm.userId, "access", { source: "added" })))
    patchRows(registry, "channels", row => ({ ...row, ...openerHints.get(row.id) }), row => openerHints.has(row.id))
    const confirmed = confirmedAttentionProjection(registry, snapshot.scopes, snapshot.items)
    replaceRows(registry, "attentionScopes", confirmed.scopes, () => true)
    replaceRows(registry, "attentionItems", confirmed.items.filter((row) => row.kind !== "friend_request" || !row.actorUserId || (!blocked.has(row.actorUserId) && !isProtectedFromQueryWrite(registry, "friendships", `user:${row.actorUserId}`))), () => true)
    const requests = collectionRows(registry, "attentionItems").filter((row) => row.kind === "friend_request" && row.actorUserId)
    upsertRows(registry, "friendships", requests.filter((row) => !blocked.has(row.actorUserId!)).map((row) => ({ id: row.sourceId, userId: row.actorUserId!, kind: "incoming" as const })))
    if (!snapshot.truncated) retireCanonicalFriendRequests(registry, pending.filter((row) => !requests.some((item) => item.sourceId === row.id)).map((row) => row.id))
    rebaseAttentionTransactions(registry)
  })
  return "applied" as const
}

export type AttentionScopeOptimisticSnapshot = AttentionIntent & { scopeId: string; targetSeq: number }
export function clearAttentionOptimistically(registry: CommunityDbRegistry): AttentionIntent {
  const floors = new Map(collectionRows(registry, "attentionScopes").map((scope) => [scope.scopeId, {
    throughSeq: Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0),
    clearedCount: scope.attentionCount, domain: scope.serverId == null ? "dms" as const : "channels" as const,
    ordinary: true, mentions: true,
  }]))
  const items = collectionRows(registry, "attentionItems").filter((item) => item.kind !== "friend_request")
  return beginAttentionIntent(registry, { floors, itemIds: new Set(items.map((item) => item.id)), itemDomains: new Map(items.map((item) => [item.id, "mentions" as const])), clearedAttentionCount: 0 })
}

export function commitAttentionOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionIntent) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionOptimisticDomains(registry: CommunityDbRegistry, snapshot: AttentionIntent, failedDomains: ReadonlySet<AttentionDomain>) {
  settleAttentionIntent(registry, snapshot, new Set((["channels", "dms", "mentions"] as const).filter((domain) => !failedDomains.has(domain))))
  return snapshot.settled
}
export function restoreAttentionOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionIntent) {
  return settleAttentionIntent(registry, snapshot)
}

export function clearAttentionScopeOptimistically(registry: CommunityDbRegistry, scopeId: string, targetSeq: number): AttentionScopeOptimisticSnapshot {
  const scope = collectionRows(registry, "attentionScopes").find((row) => row.scopeId === scopeId)
  const messages = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const items = collectionRows(registry, "attentionItems").filter((item) => item.scopeId === scopeId)
  const seqOf = (item: AttentionItemRow) => item.readTarget?.seq ?? item.openerSeq ?? (item.messageId ? messages.get(item.messageId)?.seq : undefined)
  const removed = items.filter((item) => (seqOf(item) ?? scope?.lastUnreadSeq ?? 0) <= targetSeq)
  const surviving = items.filter((item) => (item.kind === "mention" || item.kind === "reply") && (seqOf(item) ?? -1) > targetSeq).length
  const clearedAttentionCount = Math.max(0, (scope?.attentionCount ?? 0) - surviving)
  return beginAttentionIntent(registry, {
    scopeId, targetSeq, clearedAttentionCount,
    floors: new Map([[scopeId, { throughSeq: targetSeq, clearedCount: clearedAttentionCount, domain: scope?.serverId == null ? "dms" : "channels", ordinary: true, mentions: true }]]),
    itemIds: new Set(removed.map((item) => item.id)), itemDomains: new Map(removed.map((item) => [item.id, "mentions" as const])),
  }) as AttentionScopeOptimisticSnapshot
}
export function commitAttentionScopeOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionScopeOptimisticSnapshot) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionScopeOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionScopeOptimisticSnapshot) {
  return settleAttentionIntent(registry, snapshot)
}

export function removeAttentionItemsOptimistically(registry: CommunityDbRegistry, remove: (item: AttentionItemRow) => boolean): AttentionIntent {
  const items = collectionRows(registry, "attentionItems").filter(remove)
  return beginAttentionIntent(registry, { floors: new Map(), itemIds: new Set(items.map((item) => item.id)), itemDomains: new Map(items.map((item) => [item.id, "mentions" as const])), clearedAttentionCount: 0 })
}
export function commitAttentionItemsOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionIntent) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionItemsOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionIntent) {
  return settleAttentionIntent(registry, snapshot)
}

function ingestNotificationSettings(
  registry: CommunityDbRegistry,
  settings: NotificationSettings,
  mode: SnapshotIngestMode = "authoritative",
) {
  const rows: NotificationSettingRow[] = settings.raw.flatMap((row) => {
    if (Boolean(row.serverId) === Boolean(row.channelId)) return []
    const target = { serverId: row.serverId ?? null, channelId: row.channelId ?? null }
    return [{ id: notificationSettingKey(target), ...target, level: row.level }]
  })
  if (mode === "authoritative") {
    replaceRows(
      registry,
      "notificationSettings",
      rows,
      () => true,
    )
  } else {
    upsertRows(
      registry,
      "notificationSettings",
      rows,
    )
  }
}

export type CommunityLiveSnapshot =
  | { kind: "servers"; data: ServersResponse }
  | { kind: "server-detail"; data: ServerDirectorySnapshot }
  | { kind: "folders"; data: FoldersResponse }
  | { kind: "dms"; data: DmsResponse }
  | { kind: "read-state"; data: AccountReadStateSnapshot }
  | { kind: "notification-settings"; data: NotificationSettings }

declare const communityLiveSnapshotTokenBrand: unique symbol

export type CommunityLiveSnapshotToken = {
  readonly viewerId: string | null
  readonly accountEpoch: number
  readonly accessEpoch: number
  readonly channelId?: string
  readonly channelLineage?: Pick<ChannelRow, "parentChannelId">
  readonly channelScopes: ReturnType<ReturnType<typeof getCommunityRuntime>["ws"]["get"]>["channelAccessScopes"]
  readonly profileSnapshot: CommunityProfileSeedSnapshot
  readonly canonicalRevision: number
  readonly queryClient: QueryClient
  readonly registry: CommunityDbRegistry | null
  readonly ownerGeneration: number
  readonly [communityLiveSnapshotTokenBrand]: true
}

type StructuralCommunityLiveSnapshot = Exclude<CommunityLiveSnapshot, { kind: "read-state" }>

type CommunityLiveSnapshotPublication =
  | {
      snapshot: StructuralCommunityLiveSnapshot
      proof: {
        kind: "structural"
        token: CommunityLiveSnapshotToken
        signal: AbortSignal | undefined
      }
    }
  | {
      snapshot: Extract<CommunityLiveSnapshot, { kind: "read-state" }>
      proof: {
        kind: "read-state"
        token: CommunityLiveSnapshotToken
        signal: AbortSignal | undefined
        requestGeneration: number
        currentRequestGeneration: number
        targetRevision: number | null
      }
    }

export type CommunityFreshQueryProof = {
  token: CommunityLiveSnapshotToken
  signal?: AbortSignal
}

export function publishCommunityMembersSnapshot(queryClient: QueryClient, serverId: string, members: readonly { id: string; userId: string; role: string }[], proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    const previous = new Map(collectionRows(registry, "serverMemberships").map((row) => [row.id, row]))
    upsertRows(registry, "serverMemberships", members.map((member) => {
      const id = serverMembershipKey(serverId, member.userId)
      return { ...previous.get(id), id, serverId, userId: member.userId, memberId: member.id, role: member.role, viewer: member.userId === registry.accountId }
    }))
  })
}

function withCommunityQueryProof<T>(queryClient: QueryClient, proof: CommunityFreshQueryProof, publish: (registry: CommunityDbRegistry) => T): T {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  try {
  return withCanonicalWriteContext(queryClient, { kind: "query", requestRevision: proof.token.canonicalRevision, profileSnapshot: proof.token.profileSnapshot }, () => publish(proof.token.registry!))
  } catch (error) { if (error instanceof ZodError) throw requestBusinessSchemaUpdate(); throw error }
}

function ingestResourceProfiles(registry: CommunityDbRegistry, profiles: readonly CommunityResourceProfile[], proof: CommunityFreshQueryProof) {
  const resources = profiles.map(profile => CommunityResourceProfileSchema.parse(profile))
  writeCommunityProfilePatches(resources.map((profile) => communityUserProfilePatch(profile.id, profile)), registry, { snapshot: proof.token.profileSnapshot })
}

export function publishCommunityChannelMembersSnapshot(queryClient: QueryClient, serverId: string | null, channelId: string, relation: CommunityMemberRelation["relation"], members: readonly CommunityMemberRelation[], proof: CommunityFreshQueryProof, profiles: readonly CommunityResourceProfile[] = []) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    const fullProfiles = profiles.map(profile => CommunityResourceProfileSchema.parse(profile))
    const relations = members.map(member => CommunityMemberRelationSchema.parse(member))
    if (relations.some(member => member.channelId !== channelId || member.relation !== relation)) throw new Error("Member resource scope mismatch")
    if (serverId) publishCommunityMembersSnapshot(queryClient, serverId, relations.flatMap((member) => member.role === null || member.memberId === null ? [] : [{ ...member, id: member.memberId, role: member.role }]), proof)
    ingestResourceProfiles(registry, fullProfiles, proof)
    replaceRows(registry, "channelMemberships", relations.map((member) => canonicalChannelMembershipRow(channelId, member.userId, relation, { source: member.source })), (row) => row.channelId === channelId && row.relation === relation)
    pruneCanonicalTypingMembership(registry, { channelId, relation })
  })
}

export function publishCommunityMemberRole(queryClient: QueryClient, memberKey: string, memberId: string, role: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const row = collectionRows(proof.token.registry!, "serverMemberships").find((row) => row.id === memberKey)
  if (!row || row.memberId !== memberId) return false
  return publishConfirmedFields(queryClient, "serverMemberships", memberKey, { role }, proof)
}

export function publishCommunityMemberRemoval(queryClient: QueryClient, memberKey: string, memberId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  if (!collectionRows(registry, "serverMemberships").some((row) => row.id === memberKey && row.memberId === memberId)) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    deleteRows(registry, "serverMemberships", (row) => row.id === memberKey && row.memberId === memberId, [memberKey])
    return true
  })
}

export function captureCommunityLiveSnapshotToken(
  queryClient: QueryClient,
  channelId?: string,
): CommunityLiveSnapshotToken {
  const state = getCommunityRuntime(queryClient).ws.get()
  const registry = getCommunityDbRegistry(queryClient)
  const row = channelId ? registry?.collections.channels.get(channelId) : undefined
  const scope = channelId ? state.channelAccessScopes.get(channelId) : undefined
  const parentChannelId = row?.parentChannelId ?? scope?.parentChannelId
  const lineageKnown = !!row && (row.type !== "thread" || !!parentChannelId) || scope?.serverId === null || !!parentChannelId
  return {
    channelLineage: lineageKnown ? { parentChannelId: parentChannelId ?? null } : undefined,
    viewerId: state.profileViewerId,
    accountEpoch: state.profileAccountEpoch,
    accessEpoch: state.accessEpoch,
    channelId,
    channelScopes: state.channelAccessScopes,
    canonicalRevision: canonicalRevisionState(queryClient).revision,
    profileSnapshot: beginCommunityProfileSeed(getCommunityDbRegistry(queryClient)),
    queryClient,
    registry: getCommunityDbRegistry(queryClient),
    ownerGeneration: getCommunityRuntime(queryClient).lifecycle.get().generation,
  } as CommunityLiveSnapshotToken
}

export function assertCommunityLiveSnapshotTokenCurrent(
  queryClient: QueryClient,
  token: CommunityLiveSnapshotToken,
  signal: AbortSignal | undefined,
) {
  const state = getCommunityRuntime(queryClient).ws.get()
  if (
    signal?.aborted
    || !token.registry?.runtime.lifecycle.get().active
    || token.registry.runtime.lifecycle.get().generation !== token.ownerGeneration
    || state.profileViewerId !== token.viewerId
    || state.profileAccountEpoch !== token.accountEpoch
    || state.accessEpoch !== token.accessEpoch
    || (token.channelId && token.channelLineage
      ? [token.channelId, token.channelLineage.parentChannelId].some((id) => id && (state.channelAccessScopes.get(id)?.generation ?? 0) !== (token.channelScopes.get(id)?.generation ?? 0))
      : [...state.channelAccessScopes].some(([id, scope]) => scope.generation !== (token.channelScopes.get(id)?.generation ?? 0)))
    || queryClient !== token.queryClient
    || getCommunityDbRegistry(queryClient) !== token.registry
  ) throw new DOMException("Stale community live snapshot", "AbortError")
}

export function beginCommunityCommandRevision(queryClient: QueryClient, token: CommunityLiveSnapshotToken): CommunityLiveSnapshotToken {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  return { ...token, canonicalRevision: canonicalRevisionState(queryClient).revision }
}

/**
 * Publishes a newly settled live snapshot into the canonical DB.
 *
 * This is the only query-owned path allowed to replace or delete canonical
 * rows. Hydrated or manually written transport caches are never DB inputs;
 * only the fresh queryFn that owns this proof may publish its response.
 */
export function publishCommunityLiveSnapshot(
  queryClient: QueryClient,
  publication: CommunityLiveSnapshotPublication,
) {
  const { proof, snapshot } = publication
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    if (proof.kind === "read-state") {
      if (
        proof.requestGeneration !== proof.currentRequestGeneration
        || (
          proof.targetRevision !== null
          && (snapshot as Extract<CommunityLiveSnapshot, { kind: "read-state" }>).data.revision
            < proof.targetRevision
        )
      ) return "superseded" as const
    }
    switch (snapshot.kind) {
      case "servers":
        for (const server of snapshot.data.servers) registry.runtime.ws.actions.grantServerAccess(server.id)
        ingestServers(registry, snapshot.data)
        break
      case "server-detail":
        ingestServerDetail(registry, snapshot.data)
        break
      case "folders":
        ingestFolders(registry, snapshot.data)
        break
      case "dms":
        ingestDms(registry, snapshot.data)
        break
      case "read-state":
        ingestReadStateSnapshot(registry, snapshot.data)
        break
      case "notification-settings":
        ingestNotificationSettings(registry, snapshot.data)
        break
    }
    return "published" as const
  })
}

export function publishAccountAttentionSnapshot(
  queryClient: QueryClient,
  publication: {
    snapshot: AccountAttentionSnapshot
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    ingestAttentionSnapshot(registry, publication.snapshot)
    return "published" as const
  })
}

/** Merge confirmed rows from one fresh transport response into canonical DB. */
export function publishCommunityMessages(
  queryClient: QueryClient,
  publication: {
    channelId: string
    messages: MessageInput[]
    profiles: readonly CommunityResourceProfile[]
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    const graph = validateCommunityMessagePublication(registry, publication.messages, publication.profiles)
    if (graph.messages.some(message => message.channelId !== publication.channelId)) throw new Error("Message channel mismatch")
    notifyManager.batch(() => {
      ingestResourceProfiles(registry, graph.profiles, publication.proof)
      if (!getCanonicalCommunityMessageResources(queryClient, graph.messages.map(message => effectiveMessageResource(registry, message)))) throw new Error("Message profile publication incomplete")
      ingestMessages(registry, publication.channelId, graph.messages, graph.profiles)
    })
    return "published" as const
  })
}

/** Publish message entities embedded in a cross-scope transport response. */
export function publishCommunityEmbeddedMessages(
  queryClient: QueryClient,
  publication: {
    entries: Array<{ channelId: string; message: MessageInput | CommunityMessageResource }>
    profiles: readonly CommunityResourceProfile[]
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    const graph = validateCommunityMessagePublication(registry, publication.entries.map(entry => entry.message), publication.profiles)
    if (publication.entries.some(entry => entry.channelId !== entry.message.channelId)) throw new Error("Message channel mismatch")
    const byChannel = new Map<string, Array<MessageInput | CommunityMessageResource>>()
    for (const { channelId, message } of publication.entries) {
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), message])
    }
    notifyManager.batch(() => {
      ingestResourceProfiles(registry, graph.profiles, publication.proof)
      if (!getCanonicalCommunityMessageResources(queryClient, graph.messages.map(message => effectiveMessageResource(registry, message)))) throw new Error("Message profile publication incomplete")
      for (const [channelId, messages] of byChannel) {
        ingestMessages(registry, channelId, messages, graph.profiles)
      }
    })
    return "published" as const
  })
}

export function confirmCommunityConversationPresence(queryClient: QueryClient, channelId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const channel = collectionRows(registry, "channels").find(row => row.id === channelId)
  if (!channel || channel.archived || channel.pending) return
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    recordEventPatches(registry, "channels", [channelId], row => row, new Set([channelId]), [])
    const memberships = collectionRows(registry, "channelMemberships").filter(row => row.channelId === channelId && row.relation === "access")
    const keys = memberships.map(row => row.id)
    recordEventPatches(registry, "channelMemberships", keys, row => row, new Set(keys), [])
    if (channel.serverId && registry.accountId) {
      recordEventPatches(registry, "servers", [channel.serverId], row => row,
        new Set(collectionRows(registry, "servers").map(row => row.id)), [])
      const key = serverMembershipKey(channel.serverId, registry.accountId)
      recordEventPatches(registry, "serverMemberships", [key], row => row,
        new Set(collectionRows(registry, "serverMemberships").map(row => row.id)), [])
    }
  })
}

/** Publish one verified channel metadata response and its viewer access fact. */
export function publishCommunityChannelMetadata(
  queryClient: QueryClient,
  publication: {
    metadata: CommunityChannelResource
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    ingestChannelMetadata(registry, publication.metadata, publication.proof)
    const viewerId = registry.accountId
    if (viewerId) {
      upsertRows(
        registry,
        "channelMemberships",
        [canonicalChannelMembershipRow(publication.metadata.id, viewerId, "access", { source: "explicit" })],
      )
    }
    return "published" as const
  })
}

/** Merge the fresh all-server ref directory without degrading known rows. */
export function publishCommunityChannelDirectory(
  queryClient: QueryClient,
  publication: {
    directory: ChannelRefDirectory
    resources: CommunityResourceBundle
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    if (publication.directory.some(server => !publication.resources.servers.some(row => row.id === server.id)
      || server.channels.some(channel => !publication.resources.channels.some(row => row.id === channel.id && row.serverId === server.id)))) throw new Error("Channel directory resource closure mismatch")
    ingestCommunityResources(registry, publication.resources)
    return "published" as const
  })
}

export type CommunityForumSidebarChannel = CommunityChannelResource & { activityAt: string; unread: boolean; participating: boolean }
export type CommunityForumSidebarOpener = CommunityMessageResource

/** Publish the service facts carried by one forum-sidebar response. */
export function publishCommunityForumSidebar(
  queryClient: QueryClient,
  publication: {
    serverId: string
    resources: CommunityResourceBundle
    channels: CommunityForumSidebarChannel[]
    openers: CommunityForumSidebarOpener[]
    negativeRetain?: {
      id: string
      disposition: "opener-archived" | "genuine-negative"
    } | null
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    if (publication.channels.some(channel => channel.serverId !== publication.serverId || channel.type !== "thread"
      || !publication.resources.channels.some(row => row.id === channel.id && row.parentChannelId === channel.parentChannelId && row.parentMessageId === channel.parentMessageId))) throw new Error("Forum sidebar scope mismatch")
    ingestCommunityResources(registry, publication.resources)
    const viewerId = registry.accountId
    for (const channel of publication.channels) {
      if (!channel.participating || channel.archived) continue
      const current = registry.collections.channels.get(channel.id)
      if (current?.tags.includes(FORUM_ARCHIVE_TAG)) publishConfirmedFields(queryClient, "channels", channel.id, { tags: current.tags.filter(tag => tag !== FORUM_ARCHIVE_TAG) }, publication.proof)
    }
    if (publication.negativeRetain) {
      const { id, disposition } = publication.negativeRetain
      if (disposition === "opener-archived") {
        const target = collectionRows(registry, "channels")
          .find((row) => row.id === id && row.serverId === publication.serverId && row.type === "thread")
        if (target && !target.tags.includes(FORUM_ARCHIVE_TAG)) {
          publishConfirmedFields(queryClient, "channels", id, {
            tags: [...target.tags, FORUM_ARCHIVE_TAG],
          }, publication.proof)
        }
      }
      deleteRows(
        registry,
        "channelMemberships",
        (row) => row.channelId === id
          && row.userId === viewerId
          && row.relation === "notify",
      )
      retireCommunityNotificationScope(registry, id)

    }
    return "published" as const
  })
}

export function patchCanonicalCommunityChannel(
  queryClient: QueryClient,
  channelId: string,
  patch: (row: ChannelRow) => ChannelRow,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => patchRows(
    registry,
    "channels",
    patch,
    (row) => row.id === channelId,
  ))
}

export function publishCommunityChannelPatch(
  queryClient: QueryClient,
  channelId: string,
  patch: (row: ChannelRow) => ChannelRow,
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const row = collectionRows(registry, "channels").find((row) => row.id === channelId)
  if (!row) return false
  const next = patch(row)
  const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.is(value, row[key as keyof ChannelRow])))
  return publishConfirmedFields(queryClient, "channels", channelId, changes, proof)
}

function publishConfirmedFields<N extends CollectionName>(
  queryClient: QueryClient,
  name: N,
  id: string,
  changes: Partial<CommunityCollectionRows[N]>,
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const getKey = collectionKey(registry, name)
  if (!collectionRows(registry, name).some((row) => getKey(row) === id)) return false
  const revisions = canonicalRevisionState(queryClient).fieldRevisions.get(canonicalEntityKey(name, id))
  const fields = Object.keys(changes).filter((field) => (
    changes[field as keyof CommunityCollectionRows[N]] !== undefined
    && (revisions?.get("*") ?? 0) <= proof.token.canonicalRevision
    && (revisions?.get(field) ?? 0) <= proof.token.canonicalRevision
  ))
  if (!fields.length) return false
  const accepted = Object.fromEntries(fields.map((field) => [field, changes[field as keyof CommunityCollectionRows[N]]]))
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    const published = patchRows(registry, name, (row) => ({ ...row, ...accepted }), (row) => getKey(row) === id, [id], fields)
    if (name === "messages" && fields.includes("content")) {
      const message = collectionRows(registry, "messages").find((row) => row.id === id)
      if (message?.channelId && typeof message.content === "string") patchMessageFirstPreview(registry, message.channelId, id, message.content)
    }
    return published
  }))
}

function firstMessageChannel(registry: CommunityDbRegistry, channelId: string, messageId: string) {
  return collectionRows(registry, "channels").find((row) => row.id === channelId
    && row.type === "thread" && row.firstMessageId === messageId)
}

function patchMessageFirstPreview(registry: CommunityDbRegistry, channelId: string, messageId: string, content: string) {
  if (!firstMessageChannel(registry, channelId, messageId)) return
  patchRows(registry, "channels", (row) => ({ ...row, preview: content }),
    (row) => row.id === channelId && row.type === "thread" && row.firstMessageId === messageId,
    [channelId], ["preview"])
}

export function publishCommunityServerFields(
  queryClient: QueryClient,
  serverId: string,
  changes: Partial<Pick<ServerRow, "name" | "description" | "icon">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "servers", serverId, changes, proof)
}

export function publishCommunityChannelFields(
  queryClient: QueryClient,
  channelId: string,
  changes: Partial<Pick<ChannelRow, "name" | "categoryId" | "position">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "channels", channelId, changes, proof)
}

export function publishCommunityCategoryFields(
  queryClient: QueryClient,
  categoryId: string,
  changes: Partial<Pick<CategoryRow, "name" | "position">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "categories", categoryId, changes, proof)
}

export function publishCommunityMessageFields(
  queryClient: QueryClient,
  messageId: string,
  changes: Partial<MessageRow>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "messages", messageId, changes, proof)
}

export function publishCommunityMessageReaction(queryClient: QueryClient, messageId: string, emoji: string, userId: string, add: boolean, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const state = canonicalRevisionState(queryClient), registry = proof.token.registry!, field = `reaction:${emoji}:${userId}`
  const revisions = state.fieldRevisions.get(canonicalEntityKey("messages", messageId))
  if ((revisions?.get("*") ?? 0) > proof.token.canonicalRevision || (revisions?.get(field) ?? 0) > proof.token.canonicalRevision) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => patchRows(registry, "messages", (row) => ({
    ...row, reactions: applyMessageReaction((row as MessageRow & Msg).reactions, emoji, userId, add, registry.accountId || null),
  }), (row) => row.id === messageId, [messageId], ["reactions", field]))
}

export function publishCommunityForumFeed(queryClient: QueryClient, forumChannelId: string, input: CommunityThreadResources, proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => notifyManager.batch(() => {
    const { previews: _previews, ...included } = input.included
    const page = normalizeThreadResources(forumChannelId, { ...input, included })
    validateCommunityMessagePublication(registry, page.included.messages, page.included.profiles)
    const rows = page.threads.map((thread) => {
      const first = page.included.previews.find((message) => message.channelId === thread.id)
      return canonicalChannelRow({
        ...thread, type: "thread", serverId: page.channel.serverId, parentChannelId: forumChannelId,
        pending: false,
        tags: page.included.tags.filter((tag) => tag.messageId === thread.parentMessageId).map((tag) => tag.tag),
        preview: first?.content ?? "",
        firstMessageId: page.channel.type === "forum" ? first?.id || null : null,
        participantCount: page.included.participantCounts.find((row) => row.channelId === thread.id)?.count ?? 0,
      }, registry.collections.channels.get(thread.id))
    })
    upsertRows(registry, "channels", rows)
    ingestResourceProfiles(registry, page.included.profiles, proof)
    publishCommunityEmbeddedMessages(queryClient, { entries: page.included.messages.map((message) => ({ channelId: message.channelId, message })), profiles: page.included.profiles, proof })
    if (page.channel.serverId) publishCommunityMembersSnapshot(queryClient, page.channel.serverId, page.included.members.flatMap(member => member.memberId === null || member.role === null ? [] : [{ id: member.memberId, userId: member.userId, role: member.role }]), proof)
    upsertRows(registry, "channelMemberships", page.included.members.map((member) => canonicalChannelMembershipRow(member.channelId, member.userId, member.relation, { source: member.source })))
  }))
}

export function publishCommunityForumTags(queryClient: QueryClient, threadId: string, tags: string[], proof: CommunityFreshQueryProof) {
  return publishConfirmedFields(queryClient, "channels", threadId, { tags }, proof)
}

export function publishCommunityNotificationSetting(queryClient: QueryClient, target: Pick<NotificationSettingRow, "serverId" | "channelId">, level: string | null, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!, id = notificationSettingKey(target)
  if ((canonicalRevisionState(queryClient).entityRevisions.get(canonicalEntityKey("notificationSettings", id)) ?? 0) > proof.token.canonicalRevision) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    if (level === null) deleteRows(registry, "notificationSettings", (row) => row.id === id, [id])
    else upsertRows(registry, "notificationSettings", [{ id, ...target, level }])
    return true
  })
}

export function publishCommunityFriendships(queryClient: QueryClient, rows: FriendshipRow[], proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => notifyManager.batch(() => {
    const state = canonicalRevisionState(queryClient)
    const previous = collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" || row.kind === "outgoing")
    replaceRows(registry, "friendships", rows.filter((row) => (state.entityRevisions.get(canonicalEntityKey("friendships", `user:${row.userId}`)) ?? 0) <= proof.token.canonicalRevision), () => true)
    const pending = new Set(collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" || row.kind === "outgoing").map((row) => row.id))
    retireCanonicalFriendRequests(registry, previous.filter((row) => !pending.has(row.id)).map((row) => row.id))
  }))
}

export function removeSettledCommunityFriendCommands(queryClient: QueryClient, ids: readonly string[]) {
  const cache = queryClient.getMutationCache()
  for (const mutation of cache.findAll({ mutationKey: ["community", "friend-request"], predicate: (entry) => entry.state.status !== "pending" && ids.includes((entry.state.variables as { friendshipId?: string } | undefined)?.friendshipId ?? "") })) cache.remove(mutation)
}

function retireCanonicalFriendRequests(registry: CommunityDbRegistry, ids: readonly string[]) {
  const eligible = new Set(ids.filter((id) => !isProtectedFromQueryWrite(registry, "friendships", id)))
  if (!eligible.size) return
  const items = collectionRows(registry, "attentionItems").filter((row) => row.kind === "friend_request" && eligible.has(row.sourceId) && !isProtectedFromQueryWrite(registry, "attentionItems", row.id))
  const present = new Set(collectionRows(registry, "friendships").filter((row) => eligible.has(row.id) && row.kind === "accepted").map((row) => row.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => {
    deleteRows(registry, "friendships", (row) => eligible.has(row.id) && (row.kind === "incoming" || row.kind === "outgoing"), [...eligible].filter((id) => !present.has(id)))
    recordEventPatches<FriendshipRow>(registry, "friendships", present, (row) => ({ ...row, kind: "accepted" }), present, ["kind"])
    const attentionIds = new Set([...items.map((row) => row.id), ...[...eligible].map((id) => `friend_request:${id}`)])
    deleteRows(registry, "attentionItems", (row) => attentionIds.has(row.id), attentionIds)
  })
  removeSettledCommunityFriendCommands(registry.queryClient, [...eligible])
}

export function publishCommunityFriendDecision(queryClient: QueryClient, friendshipId: string, action: "accept" | "reject" | "remove", proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  if (action === "accept") publishConfirmedFields(queryClient, "friendships", friendshipId, { kind: "accepted" as const, needsOwnerApproval: null }, proof)
  else if ((canonicalRevisionState(queryClient).entityRevisions.get(canonicalEntityKey("friendships", friendshipId)) ?? 0) <= proof.token.canonicalRevision) withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(registry, "friendships", (row) => row.id === friendshipId, [friendshipId]))
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === friendshipId))
  removeSettledCommunityFriendCommands(queryClient, [friendshipId])
}

export function applyCommunityDmBlockAccess(registry: CommunityDbRegistry, peerUserId: string, blocked: boolean) {
  if (peerUserId === registry.accountId) return
  const memberships = collectionRows(registry, "channelMemberships")
  const peerChannels = new Set(memberships.filter((row) => row.userId === peerUserId && row.relation === "access").map((row) => row.channelId))
  const viewerChannels = new Set(memberships.filter((row) => row.userId === registry.accountId && row.relation === "access").map((row) => row.channelId))
  const ids = new Set(collectionRows(registry, "channels")
    .filter((row) => row.type === "dm" && row.serverId === null && peerChannels.has(row.id) && viewerChannels.has(row.id))
    .map((row) => row.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    for (const id of ids) {
      if (blocked) retireCommunityChannelReading(registry, id, { reason: "read-denied", serverId: null })
      else registry.runtime.ws.actions.beginChannelMembershipChange(null, id)
    }
  }))
}

export function publishCommunityFriendBlock(queryClient: QueryClient, userId: string, blocked: boolean, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!, state = canonicalRevisionState(queryClient)
  if ((state.entityRevisions.get(canonicalEntityKey("friendships", `user:${userId}`)) ?? 0) > proof.token.canonicalRevision) return
  const retired = blocked ? collectionRows(registry, "friendships").filter((row) => row.userId === userId).map((row) => row.id) : []
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    recordEventWrites(registry, "friendships", [`user:${userId}`])
    deleteRows(registry, "friendships", (row) => row.userId === userId && (blocked || row.kind === "blocked"))
    if (blocked) {
      upsertRows(registry, "friendships", [{ id: `blocked:${userId}`, userId, kind: "blocked" }])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.actorUserId === userId)
    }
  }))
  removeSettledCommunityFriendCommands(queryClient, retired)
}

function publishCreatedTreeRow<N extends "channels" | "categories">(
  queryClient: QueryClient,
  name: N,
  row: CommunityCollectionRows[N],
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const existing = collectionRows(registry, name).find((current) => current.id === row.id)
  if (!existing) withCommunityQueryProof(queryClient, proof, (owner) => upsertRows(owner, name, [row]))
  if (collectionRows(registry, name).some((current) => current.id === row.id)) {
    withCanonicalWriteContext(queryClient, { kind: "event" }, () => recordEventWrites(registry, name, [row.id]))
  }
}

export function publishCommunityCreatedChannel(queryClient: QueryClient, input: Parameters<typeof canonicalChannelRow>[0], proof: CommunityFreshQueryProof) {
  const row = canonicalChannelRow(input, proof.token.registry!.collections.channels.get(input.id))
  publishCreatedTreeRow(queryClient, "channels", row, proof)
  const registry = proof.token.registry!
  if (!registry.accountId || !collectionRows(registry, "channels").some((current) => current.id === row.id)) return
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => upsertRows(
    registry, "channelMemberships", [canonicalChannelMembershipRow(row.id, registry.accountId!, "access", { source: "inherited" })],
  ))
}

export function publishCommunityCreatedCategory(queryClient: QueryClient, row: CategoryRow, proof: CommunityFreshQueryProof) {
  publishCreatedTreeRow(queryClient, "categories", row, proof)
}

export function publishCommunityDeletedCategory(queryClient: QueryClient, categoryId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(proof.token.registry!, "categories", (row) => row.id === categoryId, [categoryId]))
}

export function publishCommunityServerMembershipRemoval(queryClient: QueryClient, serverId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(
    registry, "serverMemberships", (row) => row.serverId === serverId && row.viewer && row.userId === registry.accountId,
  ))
}

export function patchCanonicalCommunityMessage(
  queryClient: QueryClient,
  messageId: string,
  patch: (row: MessageRow) => MessageRow,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => (
    patchRows(
      registry,
      "messages",
      patch,
      (row) => row.id === messageId,
    )
  ))
}

function retireCommunityNotificationScope(registry: CommunityDbRegistry, channelId: string) {
  const scope = collectionRows(registry, "attentionScopes").find(row => row.channelId === channelId)
  if (!scope) return
  if (scope.attentionCount === 0) deleteRows(registry, "attentionScopes", row => row.channelId === channelId, [scope.scopeId])
  else patchRows(registry, "attentionScopes", row => ({ ...row, ordinaryUnread: false, unreadCount: 0 }), row => row.channelId === channelId, [scope.scopeId], ["ordinaryUnread", "unreadCount"])
}

export function removeCanonicalCommunityChannelMembership(
  queryClient: QueryClient,
  channelId: string,
  relation: "access" | "notify",
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId) return false
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    deleteRows(registry, "channelMemberships", row => row.channelId === channelId && row.userId === registry.accountId && row.relation === relation)
    if (relation === "notify") retireCommunityNotificationScope(registry, channelId)
  })
  return true
}

export function setCanonicalCommunityChannelMembership(
  queryClient: QueryClient,
  channelId: string,
  relation: "access" | "notify",
  present: boolean,
  options?: { event?: boolean },
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId) return false
  return setCanonicalCommunityChannelMember(queryClient, channelId, registry.accountId, relation, present, options)
}

export function setCanonicalCommunityChannelMember(queryClient: QueryClient, channelId: string, userId: string, relation: "access" | "notify", present: boolean, options?: { event?: boolean; proof?: CommunityFreshQueryProof }) {
  if (options?.proof) assertCommunityLiveSnapshotTokenCurrent(queryClient, options.proof.token, options.proof.signal)
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return false
  const id = channelMembershipKey(channelId, userId, relation)
  const write = () => {
    if (!present) {
      deleteRows(registry, "channelMemberships", (row) => row.id === id, [id])
      if (userId === registry.accountId && relation === "notify") retireCommunityNotificationScope(registry, channelId)
      return true
    }
    const previous = collectionRows(registry, "channelMemberships").find((row) => row.id === id)
    upsertRows(
      registry,
      "channelMemberships",
      [canonicalChannelMembershipRow(channelId, userId, relation, { ...previous, source: "explicit" })],
    )
    return true
  }
  if (options?.proof) return withCanonicalWriteContext(queryClient, { kind: "query", requestRevision: options.proof.token.canonicalRevision, profileSnapshot: options.proof.token.profileSnapshot }, () => isProtectedFromQueryWrite(registry, "channelMemberships", id) ? false : withCanonicalWriteContext(queryClient, { kind: "event" }, write))
  return options?.event
    ? withCanonicalWriteContext(queryClient, { kind: "event" }, write)
    : write()
}

export function getCanonicalCommunityChannels(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "channels") : []
}

export function getCanonicalCommunityAttentionScopes(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "attentionScopes") : []
}

export function getCanonicalCommunityAttentionItems(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "attentionItems") : []
}

export function getCanonicalCommunityChannelMemberships(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry
    ? collectionRows(registry, "channelMemberships")
    : []
}

export function getCanonicalCommunityMessages(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "messages") : []
}

export function purgeCommunityServer(registry: CommunityDbRegistry, serverId: string) {
  if (isProtectedFromQueryWrite(registry, "servers", serverId)) return
  const removedChannelIds = collectChannelScopeIds(registry.queryClient, serverId)
  for (const id of removedChannelIds) registry.runtime.ws.actions.revokeChannelAccess(serverId, id)
  clearChannelTransientState(registry, removedChannelIds, serverId)
  pruneInboxCaches(registry.queryClient, removedChannelIds, serverId)
  clearLastChannel(serverId)
  registry.runtime.ws.actions.revokeServerAccess(serverId)
  void registry.retireReadingDisk(removedChannelIds).catch((error: unknown) => console.error("Server cache retirement failed", error))
  registry.runtime.messageStream.actions.removeServer(serverId)
  registry.queryClient.setQueryData<string[]>(communityKeys.servers(), (current) => current?.filter((id) => id !== serverId))
  void registry.queryClient.cancelQueries({ queryKey: communityKeys.server(serverId) }, { revert: false })
  registry.queryClient.removeQueries({ queryKey: communityKeys.server(serverId) })
  const community = registry.runtime.ui.get()
  if (community.currentServerId === serverId) {
    registry.runtime.ui.actions.setCurrentChannelId(null)
    registry.runtime.ui.actions.setCurrentServerId(null)
  }
  notifyManager.batch(() => {
    deleteRows(registry, "servers", (row) => row.id === serverId, [serverId])
    deleteRows(registry, "categories", (row) => row.serverId === serverId)
    deleteRows(registry, "channels", (row) => removedChannelIds.has(row.id), removedChannelIds)
    deleteRows(registry, "serverMemberships", (row) => row.serverId === serverId)
    deleteRows(registry, "channelMemberships", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "messages", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "readStates", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "attentionScopes", (row) => (
      row.serverId === serverId || removedChannelIds.has(row.channelId)
    ))
    deleteRows(registry, "attentionItems", (row) => (
      Boolean(row.scopeId && removedChannelIds.has(row.scopeId) || row.childChannelId && removedChannelIds.has(row.childChannelId) || row.readTarget && removedChannelIds.has(row.readTarget.channelId))
    ))
    deleteRows(registry, "folderItems", (row) => row.serverId === serverId)
    deleteRows(registry, "notificationSettings", (row) => (
      row.serverId === serverId || Boolean(row.channelId && removedChannelIds.has(row.channelId))
    ))
    garbageCollectCommunityProfiles(registry)
  })
}

type ThreadPageLike = {
  serverId?: string
  threads?: Array<{ id?: string }>
}

export function collectChannelScopeIds(
  queryClient: QueryClient,
  serverId: string | null,
  channelId?: string,
) {
  const ids = new Set<string>(channelId ? [channelId] : [])
  const store = getCommunityRuntime(queryClient).ui.get()
  const current = readCurrentCommunityChannelMeta(queryClient)
  if (store.currentServerId === serverId && store.currentChannelId
    && (!channelId || current?.parentChannelId === channelId)) ids.add(store.currentChannelId)
  for (const [id, scope] of getCommunityRuntime(queryClient).ws.get().channelAccessScopes) {
    if (scope.serverId === serverId && (!channelId || scope.parentChannelId === channelId)) ids.add(id)
  }
  for (const row of getCanonicalCommunityChannels(queryClient)) {
    if (row.serverId === serverId && (!channelId || row.parentChannelId === channelId)) ids.add(row.id)
  }
  for (const { scope } of getCommunityRuntime(queryClient).messageStream.get().entries.values()) {
    if (!channelId && scope.kind === "channel" && scope.serverId === serverId) ids.add(scope.id)
  }
  const registry = getCommunityDbRegistry(queryClient)
  for (const row of registry?.collections.channels.values() ?? []) {
    if (row.serverId === serverId && (!channelId || row.id === channelId || row.parentChannelId === channelId)) ids.add(row.id)
  }
  for (const [key, data] of queryClient.getQueriesData<
    ThreadPageLike | { pages: ThreadPageLike[] }
  >({
    queryKey: ["community", "channel"],
    predicate: (query) => query.queryKey[3] === "threads" && (!channelId || query.queryKey[2] === channelId),
  })) {
    if (!data) continue
    const pages = "pages" in data ? data.pages : [data]
    for (const page of pages) {
      if (page.serverId !== serverId) continue
      ids.add(key[2] as string)
      for (const thread of page.threads ?? []) if (thread.id) ids.add(thread.id)
    }
  }
  return ids
}


export function retireCommunityChannelReading(
  registry: CommunityDbRegistry,
  channelId: string,
  options: { reason: "read-denied" | "resource-deleted"; serverId?: string | null; preserveQuery?: Query; queries?: ReadonlySet<Query>; assertView?: () => void; clearTransient?: boolean },
) {
  const root = registry.collections.channels.get(channelId)
  const serverId = options.serverId === undefined ? root?.serverId ?? null : options.serverId
  const removed = collectChannelScopeIds(registry.queryClient, serverId, channelId)
  for (const id of registry.runtime.ws.actions.revokeChannelAccess(serverId, channelId)) removed.add(id)
  for (const id of removed) if (!registry.runtime.ws.actions.isChannelAccessRevoked(id, serverId)) registry.runtime.ws.actions.revokeChannelAccess(serverId, id)
  void registry.retireReadingDisk(removed, options.reason === "resource-deleted")
    .catch((error: unknown) => console.error("Channel cache retirement failed", error))
  if (options.clearTransient !== false) clearChannelTransientState(registry, removed, serverId, options.preserveQuery, options)
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    patchRows(registry, "channels", (row) => ({ ...row, preview: "" }),
      (row) => removed.has(row.id), removed, ["preview"])
    deleteRows(registry, "messages", (row) => removed.has(row.channelId))
    deleteRows(registry, "readStates", (row) => removed.has(row.channelId))
    deleteRows(registry, "attentionScopes", (row) => removed.has(row.channelId))
    deleteRows(registry, "attentionItems", (row) => Boolean(row.scopeId && removed.has(row.scopeId) || row.childChannelId && removed.has(row.childChannelId) || row.readTarget && removed.has(row.readTarget.channelId)))
    if (options.reason === "resource-deleted" || root?.type !== "dm") {
      deleteRows(registry, "channels", (row) => removed.has(row.id), removed)
      deleteRows(registry, "channelMemberships", (row) => removed.has(row.channelId))
      deleteRows(registry, "notificationSettings", (row) => Boolean(row.channelId && removed.has(row.channelId)))
      garbageCollectCommunityProfiles(registry)
    }
  }))
  return removed
}

export function purgeCommunityChannel(registry: CommunityDbRegistry, channelId: string, clearTransient = true, preserveQuery?: Query) {
  if (isProtectedFromQueryWrite(registry, "channels", channelId) || !registry.collections.channels.has(channelId) && registry.runtime.ws.actions.isChannelAccessRevoked(channelId)) return
  retireCommunityChannelReading(registry, channelId, { reason: "resource-deleted", clearTransient, preserveQuery })
}

export function purgeCommunityForumPost(registry: CommunityDbRegistry, unit: { childChannelId: string; openerMessageId: string; serverId?: string }, options?: { queries?: ReadonlySet<Query>; assertView?: () => void }) {
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    if (registry.collections.channels.has(unit.childChannelId) || !registry.runtime.ws.actions.isChannelAccessRevoked(unit.childChannelId, unit.serverId)) retireCommunityChannelReading(registry, unit.childChannelId, { reason: "resource-deleted", serverId: unit.serverId, ...options })
    deleteRows(registry, "messages", (row) => row.id === unit.openerMessageId, [unit.openerMessageId])
    deleteRows(registry, "attentionItems", (row) => row.childChannelId === unit.childChannelId || row.messageId === unit.openerMessageId)
  }))
}

export function publishCommunityDeletedForumPost(queryClient: QueryClient, unit: { childChannelId: string; openerMessageId: string; serverId?: string }, proof: CommunityFreshQueryProof, options?: { queries?: ReadonlySet<Query>; assertView?: () => void }) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const state = canonicalRevisionState(queryClient)
  if ((state.entityRevisions.get(canonicalEntityKey("channels", unit.childChannelId)) ?? 0) > proof.token.canonicalRevision || (state.entityRevisions.get(canonicalEntityKey("messages", unit.openerMessageId)) ?? 0) > proof.token.canonicalRevision) return false
  purgeCommunityForumPost(proof.token.registry!, unit, options)
  return true
}

function projectProfilePatch(
  registry: CommunityDbRegistry,
  userId: string,
  patch: Omit<CommunityProfilePatch, "id">,
) {
  writeCommunityProfilePatches([{ id: userId, ...patch }], registry, { event: true })
}

/**
 * Applies low-latency WS facts directly to the canonical account-scoped
 * collections. Existing React Query handlers still own reconciliation and
 * fetch invalidation; a successful queryFn explicitly publishes its fresh
 * response into the same rows after its signal and account token are checked.
 */
export function projectCommunityWsEventToDb(
  queryClient: QueryClient,
  event: CommunityWsEvent,
  contract: CommunityContract = BUSINESS_SCHEMA_VERSION,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    switch (event.type) {
    case "community:friend.request": {
      const row = event.friendship
      const otherId = row.requesterId === registry.accountId ? row.addresseeId : row.requesterId
      if (collectionRows(registry, "friendships").some((friendship) => friendship.kind === "blocked" && friendship.userId === otherId)) break
      const outgoing = row.requesterId === registry.accountId
      upsertRows(registry, "friendships", [{ id: row.id, userId: outgoing ? row.addresseeId : row.requesterId, kind: outgoing ? "outgoing" : "incoming" }])
      return
    }
    case "community:friend.accept":
      patchRows(registry, "friendships", (row) => ({ ...row, kind: "accepted" as const, needsOwnerApproval: null }), (row) => row.id === event.friendshipId, [event.friendshipId], ["kind", "needsOwnerApproval"])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === event.friendshipId)
      removeSettledCommunityFriendCommands(queryClient, [event.friendshipId])
      return
    case "community:friend.reject":
    case "community:friend.remove":
      deleteRows(registry, "friendships", (row) => row.id === event.friendshipId, [event.friendshipId])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === event.friendshipId)
      removeSettledCommunityFriendCommands(queryClient, [event.friendshipId])
      return
    case "community:friend.block": {
      const retired = collectionRows(registry, "friendships").filter((row) => row.userId === event.userId).map((row) => row.id)
      recordEventWrites(registry, "friendships", [`user:${event.userId}`])
      deleteRows(registry, "friendships", (row) => row.userId === event.userId && (event.blockedByViewer === true || row.kind !== "blocked"))
      if (event.blockedByViewer) upsertRows(registry, "friendships", [{ id: `blocked:${event.userId}`, userId: event.userId, kind: "blocked" }])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.actorUserId === event.userId)
      removeSettledCommunityFriendCommands(queryClient, retired)
      return
    }
    case "community:message.create": {
      const projected = projectCommunityMessageCreate(event.message, event.channelId, contract)
      const graph = validateCommunityMessagePublication(registry, [projected], event.profiles)
      notifyManager.batch(() => {
        writeCanonicalProfilePatches(registry, graph.profiles.map(profile => communityUserProfilePatch(profile.id, profile)), true)
        ingestMessages(registry, event.channelId, graph.messages, graph.profiles)
      })
      if (event.message.createdAt) {
        patchRows(
          registry,
          "channels",
          (row) => ({ ...row, lastMessageAt: event.message.createdAt }),
          (row) => row.id === event.channelId,
          [event.channelId],
        )
      }
      return projected
    }
    case "community:message.updated": {
      const changes = {
        ...(event.approval !== undefined ? { approval: event.approval } : {}),
        ...(event.botCreation !== undefined ? { botCreation: event.botCreation } : {}),
      }
      patchRows(
        registry,
        "messages",
        (row) => row.channelId === event.channelId ? { ...row, ...changes } : row,
        (row) => row.id === event.messageId && row.channelId === event.channelId,
        [event.messageId],
        Object.keys(changes),
      )
      return
    }
    case "community:reaction.add":
    case "community:reaction.remove":
      patchRows(
        registry,
        "messages",
        (row) => ({ ...row, reactions: applyMessageReaction((row as MessageRow & Msg).reactions, event.emoji, event.userId, event.type === "community:reaction.add", registry.accountId || null) }),
        (row) => row.id === event.messageId,
        [event.messageId],
        ["reactions", `reaction:${event.emoji}:${event.userId}`],
      )
      return
    case "community:channel.child_create": {
      const full = CommunityChannelResourceSchema.parse(event.channel)
      const parent = collectionRows(registry, "channels").find(row => row.id === event.parentChannelId)
      if (!parent?.serverId) return
      if (full.serverId !== parent.serverId || full.parentChannelId !== parent.id || full.parentMessageId !== event.parentMessageId) throw new Error("Child channel scope mismatch")
      const existing = collectionRows(registry, "channels").find(row => row.id === full.id)
      upsertRows(registry, "channels", [canonicalChannelRow(full, existing)])
      if (registry.accountId) {
        upsertRows(
          registry,
          "channelMemberships",
          [canonicalChannelMembershipRow(event.channel.id, registry.accountId, "access", { source: "explicit" })],
        )
      }
      return
    }
    case "community:channel.child_update":
      patchRows(
        registry,
        "channels",
        (row) => ({
          ...row,
          ...(event.changes.name === undefined ? {} : { name: event.changes.name }),
          ...(event.changes.archived === undefined ? {} : { archived: event.changes.archived }),
          ...(event.changes.tags === undefined ? {} : { tags: event.changes.tags ?? [] }),
          ...(event.changes.lastMessageAt === undefined ? {} : { lastMessageAt: event.changes.lastMessageAt }),
          ...(event.changes.messageCount === undefined ? {} : { messageCount: event.changes.messageCount }),
        }),
        (row) => row.id === event.channelId,
        [event.channelId],
        Object.keys(event.changes),
      )
      return
    case "community:server.update":
      patchRows(
        registry,
        "servers",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.serverId,
        [event.serverId],
        Object.keys(event.changes),
      )
      return
    case "community:channel.create": {
      const existing = collectionRows(registry, "channels").find((row) => row.id === event.channel.id)
      const full = CommunityChannelResourceSchema.parse(event.channel)
      if (full.serverId !== event.serverId) throw new Error("Channel server mismatch")
      upsertRows(registry, "channels", [canonicalChannelRow(full, existing)])
      return
    }
    case "community:channel.update":
      patchRows(
        registry,
        "channels",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.channelId,
        [event.channelId],
        Object.keys(event.changes),
      )
      return
    case "community:channel.delete":
      if (event.parentChannelId && event.parentMessageId) {
        purgeCommunityForumPost(registry, { childChannelId: event.channelId, openerMessageId: event.parentMessageId })
      } else purgeCommunityChannel(registry, event.channelId)
      return
    case "community:channel.reorder": {
      const positionById = new Map(event.channels.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "channels",
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
        ["position"],
      )
      return
    }
    case "community:channel.membership.change":
      return
    case "community:category.create":
      upsertRows(registry, "categories", [{
        id: event.category.id,
        serverId: event.serverId,
        name: event.category.name,
        position: event.category.position,
        private: event.category.private,
        creatorId: event.category.creatorId,
        pending: false,
      }])
      return
    case "community:category.update":
      patchRows(
        registry,
        "categories",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.categoryId,
        [event.categoryId],
        Object.keys(event.changes),
      )
      return
    case "community:category.delete":
      deleteRows(
        registry,
        "categories",
        (row) => row.id === event.categoryId,
        [event.categoryId],
      )
      return
    case "community:category.reorder": {
      const positionById = new Map(event.categories.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "categories",
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
        ["position"],
      )
      return
    }
    case "community:member.join":
      upsertRows(registry, "serverMemberships", [{
        id: serverMembershipKey(event.serverId, event.member.userId),
        serverId: event.serverId,
        userId: event.member.userId,
        memberId: event.member.id,
        role: event.member.role,
        joinedAt: event.member.joinedAt,
        viewer: event.member.userId === registry.accountId,
      }])
      writeCommunityProfilePatches([communityUserProfilePatch(event.member.userId, {
        name: event.member.name,
        discriminator: event.member.discriminator,
        ...(event.member.avatar === undefined ? {} : { avatar: canonicalUserImage(event.member.userId, event.member.avatar, event.member.avatarVersion) }),
        avatarVersion: event.member.avatarVersion,
      })], registry, { event: true })
      return
    case "community:member.leave": {
      if (event.userId !== registry.accountId) {
        const channels = collectionRows(registry, "channels").filter((row) => row.serverId === event.serverId)
        const scopes = registry.runtime.ws.get().channelAccessScopes
        const channelIds = collectChannelScopeIds(queryClient, event.serverId)
        const notifyKeys = new Set(collectionRows(registry, "channelMemberships").filter((row) => channelIds.has(row.channelId) && row.userId === event.userId && row.relation === "notify").map((row) => row.id))
        for (const [scopeKey, users] of registry.runtime.ui.get().typingByScope) {
          const id = scopeKey.startsWith("ch:") ? scopeKey.slice(3) : null
          if (id && channelIds.has(id) && users.has(event.userId)
            && (channels.some((row) => row.id === id && row.type === "thread") || scopes.get(id)?.parentChannelId)) {
            notifyKeys.add(channelMembershipKey(id, event.userId, "notify"))
          }
        }
        deleteRows(
          registry,
          "serverMemberships",
          (row) => row.serverId === event.serverId && row.userId === event.userId,
          [serverMembershipKey(event.serverId, event.userId)],
        )
        deleteRows(registry, "channelMemberships", (row) => channelIds.has(row.channelId) && row.userId === event.userId && row.relation === "notify", notifyKeys)
        deleteRows(registry, "channelMemberships", (row) => channelIds.has(row.channelId) && row.userId === event.userId && row.relation === "access")
      }
      return
    }
    case "community:member.update":
      patchRows(
        registry,
        "serverMemberships",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.serverId === event.serverId
          && (row.memberId === event.memberId || Boolean(event.userId && row.userId === event.userId)),
        event.userId ? [serverMembershipKey(event.serverId, event.userId)] : undefined,
        Object.keys(event.changes),
      )
      return
    case "community:status.update":
      projectProfilePatch(registry, event.userId, {
        status: {
          statusEmoji: event.statusEmoji,
          statusText: event.statusText,
        },
      })
      return
    case "community:identity.update":
      projectProfilePatch(registry, event.userId, {
        avatar: {
          avatar: event.avatar,
          avatarVersion: event.avatarVersion,
        },
      })
      return
    case "community:profile.update": {
      projectProfilePatch(registry, event.userId, {
        identityAbout: {
          name: event.name,
          discriminator: event.discriminator,
          aboutMe: event.aboutMe,
          bannerColor: event.bannerColor,
          kind: event.kind,
          ownerUserId: event.ownerUserId,
        },
      })
      return
    }
      default:
        return
    }
  })
}

export function installCommunityDbSync(
  queryClient: QueryClient,
  registry: CommunityDbRegistry,
) {
  // Canonical collections hydrate themselves. Raw Query payloads are never
  // replayed into DB: a cache notification does not prove request freshness.
  void queryClient
  void registry.preload().catch((error: unknown) => {
    if (isAbortError(error)) return
    console.error("Community collection preload failed", error)
  })
  return () => {}
}

export function communityRequestOptions(queryClient: QueryClient, signal?: AbortSignal) {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  return qualifiedCommunityRequestOptions(queryClient, token, signal)
}
