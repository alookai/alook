import type { QueryClient } from "@tanstack/react-query"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type {
  Category,
  CommunityFolder,
  Server,
} from "@/lib/community/models/navigation"
import { communityKeys } from "@/lib/query-keys"

const STRUCTURAL_SNAPSHOT_VERSION = 1 as const
export const STRUCTURAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000
export const STRUCTURAL_SNAPSHOT_CHILD_LIMIT = 32

export type StructuralCategoryV1 = {
  id: string
  name: string
  private: boolean
}

export type StructuralChannelV1 = {
  id: string
  name: string
  type: "text" | "forum"
  categoryId: string | null
}

type StructuralChildRouteHintV1 = {
  id: string
  name: string
  type: "thread"
  parentChannelId: string
  parentMessageId: string
}

export type StructuralServerV1 = {
  id: string
  name: string
  discriminator: string
  icon: string | null
  categories: StructuralCategoryV1[]
  channels: StructuralChannelV1[]
  childRouteHints: StructuralChildRouteHintV1[]
}

export type StructuralSnapshotV1 = {
  schemaVersion: 1
  accountId: string
  capturedAt: number
  serverOrder: string[]
  folders: Array<{
    id: string
    name: string
    serverIds: string[]
  }>
  servers: StructuralServerV1[]
}

export type StructuralSnapshotEvent =
  | {
      type: "replaceServers"
      accountId: string
      servers: Array<Pick<StructuralServerV1, "id" | "name" | "discriminator" | "icon">>
    }
  | {
      type: "replaceFolders"
      folders: Array<{ id: string; name: string; serverIds: string[] }>
    }
  | {
      type: "replaceServerTree"
      serverId: string
      categories: StructuralCategoryV1[]
      channels: StructuralChannelV1[]
    }
  | {
      type: "replaceRail"
      serverOrder: string[]
      folders: Array<{ id: string; name: string; serverIds: string[] }>
    }
  | {
      type: "patchServer"
      serverId: string
      changes: Partial<Pick<StructuralServerV1, "name" | "icon">>
    }
  | { type: "removeServer"; serverId: string }
  | {
      type: "upsertCategory"
      serverId: string
      category: StructuralCategoryV1
      position?: number
    }
  | {
      type: "patchCategory"
      serverId: string
      categoryId: string
      changes: Partial<Pick<StructuralCategoryV1, "name" | "private">>
      position?: number
    }
  | { type: "removeCategory"; serverId: string; categoryId: string }
  | {
      type: "reorderCategories"
      serverId: string
      categoryIds: string[]
    }
  | {
      type: "upsertChannel"
      serverId: string
      channel: StructuralChannelV1
      position?: number
    }
  | {
      type: "patchChannel"
      serverId: string
      channelId: string
      changes: Partial<Pick<StructuralChannelV1, "name" | "type" | "categoryId">>
    }
  | { type: "removeChannel"; serverId: string; channelId: string }
  | {
      type: "reorderChannels"
      serverId: string
      channelIds: string[]
    }
  | {
      type: "upsertChildHint"
      serverId: string
      child: StructuralChildRouteHintV1
    }
  | {
      type: "patchChildHint"
      serverId: string
      channelId: string
      name?: string
    }
  | { type: "removeChildHint"; serverId: string; channelId: string }

type ServerDetailSource = {
  categories: Array<{
    id: string
    name: string
    private?: boolean | number
    pending?: boolean
    channels: Array<{
      id: string
      name: string
      type?: string
      pending?: boolean
    }>
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("tmp_")
    && !value.startsWith("temp_")
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function parseCategory(value: unknown): StructuralCategoryV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "private"])) return null
  if (!isSafeId(value.id) || !isString(value.name) || typeof value.private !== "boolean") return null
  return { id: value.id, name: value.name, private: value.private }
}

function parseChannel(value: unknown): StructuralChannelV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "type", "categoryId"])) return null
  if (!isSafeId(value.id) || !isString(value.name)) return null
  if (value.type !== "text" && value.type !== "forum") return null
  if (value.categoryId !== null && !isSafeId(value.categoryId)) return null
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    categoryId: value.categoryId,
  }
}

function parseChild(value: unknown): StructuralChildRouteHintV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "name",
    "type",
    "parentChannelId",
    "parentMessageId",
  ])) return null
  if (
    !isSafeId(value.id)
    || !isString(value.name)
    || value.type !== "thread"
    || !isSafeId(value.parentChannelId)
    || !isSafeId(value.parentMessageId)
  ) return null
  return {
    id: value.id,
    name: value.name,
    type: "thread",
    parentChannelId: value.parentChannelId,
    parentMessageId: value.parentMessageId,
  }
}

function parseServer(value: unknown): StructuralServerV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "name",
    "discriminator",
    "icon",
    "categories",
    "channels",
    "childRouteHints",
  ])) return null
  if (
    !isSafeId(value.id)
    || !isString(value.name)
    || !isString(value.discriminator)
    || (value.icon !== null && !isString(value.icon))
    || !Array.isArray(value.categories)
    || !Array.isArray(value.channels)
    || !Array.isArray(value.childRouteHints)
    || value.childRouteHints.length > STRUCTURAL_SNAPSHOT_CHILD_LIMIT
  ) return null
  const categories = value.categories.map(parseCategory)
  const channels = value.channels.map(parseChannel)
  const children = value.childRouteHints.map(parseChild)
  if (categories.some((row) => row === null)
    || channels.some((row) => row === null)
    || children.some((row) => row === null)) return null
  const parsedCategories = categories as StructuralCategoryV1[]
  const parsedChannels = channels as StructuralChannelV1[]
  const parsedChildren = children as StructuralChildRouteHintV1[]
  const categoryIds = parsedCategories.map((row) => row.id)
  const channelIds = parsedChannels.map((row) => row.id)
  const childIds = parsedChildren.map((row) => row.id)
  if (!unique(categoryIds) || !unique(channelIds) || !unique(childIds)) return null
  const categorySet = new Set(categoryIds)
  const channelSet = new Set(channelIds)
  if (parsedChannels.some((row) => row.categoryId !== null && !categorySet.has(row.categoryId))) return null
  if (parsedChildren.some((row) => !channelSet.has(row.parentChannelId))) return null
  if ([...channelIds, ...childIds].some((id, index, all) => all.indexOf(id) !== index)) return null
  return {
    id: value.id,
    name: value.name,
    discriminator: value.discriminator,
    icon: value.icon,
    categories: parsedCategories,
    channels: parsedChannels,
    childRouteHints: parsedChildren,
  }
}

export function parseStructuralSnapshot(
  value: unknown,
  accountId: string,
  now = Date.now(),
): StructuralSnapshotV1 | null {
  if (!accountId || !isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "accountId",
    "capturedAt",
    "serverOrder",
    "folders",
    "servers",
  ])) return null
  if (
    value.schemaVersion !== STRUCTURAL_SNAPSHOT_VERSION
    || value.accountId !== accountId
    || typeof value.capturedAt !== "number"
    || !Number.isFinite(value.capturedAt)
    || value.capturedAt < 0
    || value.capturedAt > now
    || now - value.capturedAt > STRUCTURAL_SNAPSHOT_TTL_MS
    || !Array.isArray(value.serverOrder)
    || !Array.isArray(value.folders)
    || !Array.isArray(value.servers)
  ) return null
  if (!value.serverOrder.every(isSafeId) || !unique(value.serverOrder)) return null
  const serverOrder = value.serverOrder as string[]
  const servers = value.servers.map(parseServer)
  if (servers.some((server) => server === null)) return null
  const parsedServers = servers as StructuralServerV1[]
  const serverIds = parsedServers.map((server) => server.id)
  if (!unique(serverIds)
    || serverIds.length !== serverOrder.length
    || serverIds.some((id) => !serverOrder.includes(id))) return null
  const serverSet = new Set(serverIds)
  const claimed = new Set<string>()
  const folders: StructuralSnapshotV1["folders"] = []
  for (const valueFolder of value.folders) {
    if (!isRecord(valueFolder) || !hasExactKeys(valueFolder, ["id", "name", "serverIds"])) return null
    if (!isSafeId(valueFolder.id) || !isString(valueFolder.name) || !Array.isArray(valueFolder.serverIds)) return null
    if (!valueFolder.serverIds.every(isSafeId)
      || !unique(valueFolder.serverIds)
      || valueFolder.serverIds.some((id) => !serverSet.has(id) || claimed.has(id))) return null
    for (const id of valueFolder.serverIds) claimed.add(id)
    folders.push({ id: valueFolder.id, name: valueFolder.name, serverIds: [...valueFolder.serverIds] })
  }
  if (!unique(folders.map((folder) => folder.id))) return null
  return {
    schemaVersion: STRUCTURAL_SNAPSHOT_VERSION,
    accountId,
    capturedAt: value.capturedAt,
    serverOrder: [...serverOrder],
    folders,
    servers: parsedServers,
  }
}

function moveToPosition<T>(values: readonly T[], value: T, position?: number): T[] {
  const next = [...values]
  const index = position === undefined
    ? next.length
    : Math.max(0, Math.min(Math.trunc(position), next.length))
  next.splice(index, 0, value)
  return next
}

function orderByIds<T extends { id: string }>(values: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(values.map((value) => [value.id, value]))
  const ordered = ids.flatMap((id) => {
    const value = byId.get(id)
    if (!value) return []
    byId.delete(id)
    return [value]
  })
  return [...ordered, ...byId.values()]
}

function withServer(
  snapshot: StructuralSnapshotV1,
  serverId: string,
  update: (server: StructuralServerV1) => StructuralServerV1,
  now: number,
): StructuralSnapshotV1 {
  let changed = false
  const servers = snapshot.servers.map((server) => {
    if (server.id !== serverId) return server
    const next = update(server)
    changed = changed || next !== server
    return next
  })
  return changed ? { ...snapshot, capturedAt: now, servers } : snapshot
}

function normalizedFolders(
  snapshot: StructuralSnapshotV1,
  folders: StructuralSnapshotV1["folders"],
): StructuralSnapshotV1["folders"] {
  const serverIds = new Set(snapshot.serverOrder)
  const claimed = new Set<string>()
  const folderIds = new Set<string>()
  return folders.flatMap((folder) => {
    if (!isSafeId(folder.id) || !isString(folder.name) || folderIds.has(folder.id)) return []
    folderIds.add(folder.id)
    const ids = folder.serverIds.filter((id) => {
      if (!serverIds.has(id) || claimed.has(id)) return false
      claimed.add(id)
      return true
    })
    return [{ id: folder.id, name: folder.name, serverIds: ids }]
  })
}

export function reduceStructuralSnapshot(
  current: StructuralSnapshotV1 | undefined,
  event: StructuralSnapshotEvent,
  now = Date.now(),
): StructuralSnapshotV1 | undefined {
  if (event.type === "replaceServers") {
    const previous = current?.accountId === event.accountId ? current : undefined
    const previousById = new Map(previous?.servers.map((server) => [server.id, server]) ?? [])
    const servers = event.servers
      .filter((server) => isSafeId(server.id))
      .filter((server, index, all) => all.findIndex((candidate) => candidate.id === server.id) === index)
      .map((server) => ({
        id: server.id,
        name: server.name,
        discriminator: server.discriminator,
        icon: server.icon,
        categories: previousById.get(server.id)?.categories ?? [],
        channels: previousById.get(server.id)?.channels ?? [],
        childRouteHints: previousById.get(server.id)?.childRouteHints ?? [],
      }))
    const snapshot: StructuralSnapshotV1 = {
      schemaVersion: STRUCTURAL_SNAPSHOT_VERSION,
      accountId: event.accountId,
      capturedAt: now,
      serverOrder: servers.map((server) => server.id),
      folders: [],
      servers,
    }
    snapshot.folders = normalizedFolders(snapshot, previous?.folders ?? [])
    return snapshot
  }
  if (!current) return current
  if (event.type === "replaceFolders") {
    return { ...current, capturedAt: now, folders: normalizedFolders(current, event.folders) }
  }
  if (event.type === "replaceRail") {
    const known = new Set(current.serverOrder)
    const serverOrder = event.serverOrder.filter(
      (id, index, values) => known.has(id) && values.indexOf(id) === index,
    )
    for (const id of current.serverOrder) if (!serverOrder.includes(id)) serverOrder.push(id)
    const next = { ...current, capturedAt: now, serverOrder }
    return { ...next, folders: normalizedFolders(next, event.folders) }
  }
  if (event.type === "removeServer") {
    if (!current.serverOrder.includes(event.serverId)) return current
    return {
      ...current,
      capturedAt: now,
      serverOrder: current.serverOrder.filter((id) => id !== event.serverId),
      folders: current.folders.flatMap((folder) => {
        const serverIds = folder.serverIds.filter((id) => id !== event.serverId)
        return serverIds.length > 0 ? [{ ...folder, serverIds }] : []
      }),
      servers: current.servers.filter((server) => server.id !== event.serverId),
    }
  }
  if (event.type === "patchServer") {
    return withServer(current, event.serverId, (server) => ({ ...server, ...event.changes }), now)
  }
  if (event.type === "replaceServerTree") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      categories: event.categories,
      channels: event.channels,
      childRouteHints: server.childRouteHints.filter((child) =>
        event.channels.some((channel) => channel.id === child.parentChannelId)),
    }), now)
  }
  if (event.type === "upsertCategory") {
    return withServer(current, event.serverId, (server) => {
      const without = server.categories.filter((category) => category.id !== event.category.id)
      return { ...server, categories: moveToPosition(without, event.category, event.position) }
    }, now)
  }
  if (event.type === "patchCategory") {
    return withServer(current, event.serverId, (server) => {
      const existing = server.categories.find((category) => category.id === event.categoryId)
      if (!existing) return server
      const category = { ...existing, ...event.changes }
      const categories = server.categories.filter((row) => row.id !== event.categoryId)
      return {
        ...server,
        categories: event.position === undefined
          ? server.categories.map((row) => row.id === event.categoryId ? category : row)
          : moveToPosition(categories, category, event.position),
      }
    }, now)
  }
  if (event.type === "removeCategory") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      categories: server.categories.filter((category) => category.id !== event.categoryId),
      channels: server.channels.map((channel) =>
        channel.categoryId === event.categoryId ? { ...channel, categoryId: null } : channel),
    }), now)
  }
  if (event.type === "reorderCategories") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      categories: orderByIds(server.categories, event.categoryIds),
    }), now)
  }
  if (event.type === "upsertChannel") {
    return withServer(current, event.serverId, (server) => {
      const without = server.channels.filter((channel) => channel.id !== event.channel.id)
      return { ...server, channels: moveToPosition(without, event.channel, event.position) }
    }, now)
  }
  if (event.type === "patchChannel") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      channels: server.channels.map((channel) =>
        channel.id === event.channelId ? { ...channel, ...event.changes } : channel),
    }), now)
  }
  if (event.type === "reorderChannels") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      channels: orderByIds(server.channels, event.channelIds),
    }), now)
  }
  if (event.type === "removeChannel") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      channels: server.channels.filter((channel) => channel.id !== event.channelId),
      childRouteHints: server.childRouteHints.filter((child) =>
        child.id !== event.channelId && child.parentChannelId !== event.channelId),
    }), now)
  }
  if (event.type === "upsertChildHint") {
    return withServer(current, event.serverId, (server) => {
      if (!server.channels.some((channel) => channel.id === event.child.parentChannelId)) return server
      const childRouteHints = [
        event.child,
        ...server.childRouteHints.filter((child) => child.id !== event.child.id),
      ].slice(0, STRUCTURAL_SNAPSHOT_CHILD_LIMIT)
      return { ...server, childRouteHints }
    }, now)
  }
  if (event.type === "patchChildHint") {
    return withServer(current, event.serverId, (server) => ({
      ...server,
      childRouteHints: server.childRouteHints.map((child) =>
        child.id === event.channelId && event.name !== undefined
          ? { ...child, name: event.name }
          : child),
    }), now)
  }
  return withServer(current, event.serverId, (server) => ({
    ...server,
    childRouteHints: server.childRouteHints.filter((child) => child.id !== event.channelId),
  }), now)
}

export function updateStructuralSnapshot(
  queryClient: QueryClient,
  event: StructuralSnapshotEvent,
  now = Date.now(),
): void {
  queryClient.setQueryData<StructuralSnapshotV1 | undefined>(
    communityKeys.structuralSnapshot(),
    (current) => reduceStructuralSnapshot(current, event, now),
  )
}

export function projectServerDetailTree(detail: ServerDetailSource): {
  categories: StructuralCategoryV1[]
  channels: StructuralChannelV1[]
} {
  const categories: StructuralCategoryV1[] = []
  const channels: StructuralChannelV1[] = []
  for (const category of detail.categories) {
    if (category.pending || !isSafeId(category.id)) continue
    const uncategorized = category.id === UNCATEGORIZED_CATEGORY_ID || category.name === ""
    if (!uncategorized) {
      categories.push({
        id: category.id,
        name: category.name,
        private: category.private === true || category.private === 1,
      })
    }
    for (const channel of category.channels) {
      if (channel.pending || !isSafeId(channel.id)) continue
      if (channel.type !== "text" && channel.type !== "forum") continue
      channels.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        categoryId: uncategorized ? null : category.id,
      })
    }
  }
  return { categories, channels }
}

export function structuralServerToCategories(server: StructuralServerV1): Category[] {
  const categories: Category[] = server.categories.map((category) => ({
    id: category.id,
    name: category.name,
    private: category.private,
    channels: server.channels
      .filter((channel) => channel.categoryId === category.id)
      .map((channel) => ({ ...channel, active: false, unread: false })),
  }))
  const uncategorized = server.channels
    .filter((channel) => channel.categoryId === null)
    .map((channel) => ({ ...channel, active: false, unread: false }))
  if (uncategorized.length > 0) {
    categories.push({
      id: UNCATEGORIZED_CATEGORY_ID,
      name: "",
      private: false,
      channels: uncategorized,
    })
  }
  return categories
}

export function structuralSnapshotServers(snapshot: StructuralSnapshotV1 | null): Server[] {
  if (!snapshot) return []
  const byId = new Map(snapshot.servers.map((server) => [server.id, server]))
  return snapshot.serverOrder.flatMap((id) => {
    const server = byId.get(id)
    if (!server) return []
    return [{
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      icon: server.icon,
      initial: avatarInitial(server.name),
      active: false,
      unread: false,
      mentions: 0,
    }]
  })
}

export function structuralSnapshotFolders(snapshot: StructuralSnapshotV1 | null): CommunityFolder[] {
  if (!snapshot) return []
  const byId = new Map(structuralSnapshotServers(snapshot).map((server) => [server.id, server]))
  return snapshot.folders.map((folder, position) => ({
    id: folder.id,
    name: folder.name,
    position,
    servers: folder.serverIds.flatMap((id) => {
      const server = byId.get(id)
      return server ? [{ id, name: server.name, initial: server.initial, icon: server.icon }] : []
    }),
  }))
}

export function structuralSnapshotDirectory(snapshot: StructuralSnapshotV1 | null): ChannelRefDirectory {
  if (!snapshot) return []
  return snapshot.servers.map((server) => ({
    id: server.id,
    name: server.name,
    discriminator: server.discriminator,
    channels: server.channels.map((channel) => ({ id: channel.id, name: channel.name })),
  }))
}
