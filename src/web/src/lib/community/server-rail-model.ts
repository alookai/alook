import { MAX_SERVER_RAIL_FOLDERS, type ServerRailCommand } from "@alook/shared"

import type { CommunityFolder } from "@/lib/community/models/navigation"

export type RailEntity =
  | { kind: "server"; id: string }
  | { kind: "folder"; id: string }

export type RailOperation = "reorder-before" | "reorder-after" | "combine"

export type RailOperationAvailability = Record<RailOperation, boolean>

export type RailInstruction = {
  operation: RailOperation
  source: RailEntity
  target: RailEntity
  newFolderId?: string
}

export type RailState = {
  serverOrder: string[]
  folderOrder: string[]
  folders: Record<string, string[]>
  expanded: string[]
}

export type RailCommitResult =
  | { applied: true; state: RailState; commands: ServerRailCommand[] }
  | { applied: false; state: RailState; reason: string }

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function railStateFromData(
  serverIds: readonly string[],
  folders: readonly CommunityFolder[],
  expanded: readonly string[],
): RailState {
  const membershipIds = new Set(serverIds)
  const claimedServerIds = new Set<string>()
  const projectedFolders = [...folders]
    .sort((left, right) => left.position - right.position
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((folder) => ({
      id: folder.id,
      serverIds: folder.servers
        .map((server) => server.id)
        .filter((serverId) => {
          if (!membershipIds.has(serverId) || claimedServerIds.has(serverId)) return false
          claimedServerIds.add(serverId)
          return true
        }),
    }))
    .filter((folder) => folder.serverIds.length > 0)
  return {
    serverOrder: [...serverIds],
    folderOrder: projectedFolders.map((folder) => folder.id),
    folders: Object.fromEntries(
      projectedFolders.map((folder) => [folder.id, folder.serverIds]),
    ),
    expanded: expanded.filter((folderId) => projectedFolders.some((folder) => folder.id === folderId)),
  }
}

export function cloneRailState(state: RailState): RailState {
  return {
    serverOrder: [...state.serverOrder],
    folderOrder: [...state.folderOrder],
    folders: Object.fromEntries(
      Object.entries(state.folders).map(([folderId, serverIds]) => [folderId, [...serverIds]]),
    ),
    expanded: [...state.expanded],
  }
}

function folderForServer(state: RailState, serverId: string): string | null {
  for (const folderId of state.folderOrder) {
    if (state.folders[folderId]?.includes(serverId)) return folderId
  }
  return null
}

export function visibleTopLevelServers(state: RailState): string[] {
  const claimed = new Set(Object.values(state.folders).flat())
  return state.serverOrder.filter((serverId) => !claimed.has(serverId))
}

export function railStateErrors(state: RailState): string[] {
  const errors: string[] = []
  const serverIds = new Set(state.serverOrder)
  if (serverIds.size !== state.serverOrder.length) errors.push("server order contains duplicates")
  if (new Set(state.folderOrder).size !== state.folderOrder.length) errors.push("folder order contains duplicates")
  if (state.folderOrder.length > MAX_SERVER_RAIL_FOLDERS) errors.push("folder limit reached")
  const claimed = new Set<string>()
  for (const folderId of state.folderOrder) {
    const items = state.folders[folderId]
    if (!items) {
      errors.push(`folder ${folderId} is missing`)
      continue
    }
    if (items.length === 0) errors.push(`folder ${folderId} is empty`)
    if (new Set(items).size !== items.length) errors.push(`folder ${folderId} contains duplicates`)
    for (const serverId of items) {
      if (!state.serverOrder.includes(serverId)) errors.push(`folder ${folderId} contains unknown server`)
      if (claimed.has(serverId)) errors.push(`server ${serverId} belongs to multiple folders`)
      claimed.add(serverId)
    }
  }
  for (const folderId of Object.keys(state.folders)) {
    if (!state.folderOrder.includes(folderId)) errors.push(`folder ${folderId} is unordered`)
  }
  return errors
}

function samePersistedState(left: RailState, right: RailState): boolean {
  return sameArray(left.serverOrder, right.serverOrder)
    && sameArray(left.folderOrder, right.folderOrder)
    && left.folderOrder.every((folderId) =>
      sameArray(left.folders[folderId] ?? [], right.folders[folderId] ?? []),
    )
}

function moveRelative(
  list: readonly string[],
  sourceId: string,
  targetId: string,
  after: boolean,
): string[] {
  const next = list.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  if (targetIndex === -1) return [...list]
  next.splice(targetIndex + (after ? 1 : 0), 0, sourceId)
  return next
}

function removeServerFromFolder(state: RailState, serverId: string): void {
  const folderId = folderForServer(state, serverId)
  if (!folderId) return
  state.folders[folderId] = state.folders[folderId]!.filter((id) => id !== serverId)
  if (state.folders[folderId]!.length > 0) return
  delete state.folders[folderId]
  state.folderOrder = state.folderOrder.filter((id) => id !== folderId)
  state.expanded = state.expanded.filter((id) => id !== folderId)
}

function moveServerRelative(
  state: RailState,
  sourceId: string,
  targetId: string,
  after: boolean,
): boolean {
  const sourceFolder = folderForServer(state, sourceId)
  const targetFolder = folderForServer(state, targetId)
  if (sourceFolder === targetFolder) {
    if (sourceFolder) {
      state.folders[sourceFolder] = moveRelative(
        state.folders[sourceFolder]!,
        sourceId,
        targetId,
        after,
      )
    } else {
      state.serverOrder = moveRelative(state.serverOrder, sourceId, targetId, after)
    }
    return true
  }
  removeServerFromFolder(state, sourceId)
  if (targetFolder) {
    state.folders[targetFolder] = moveRelative(
      [...state.folders[targetFolder]!, sourceId],
      sourceId,
      targetId,
      after,
    )
    state.expanded = unique([...state.expanded, targetFolder])
    return true
  }
  state.serverOrder = moveRelative(state.serverOrder, sourceId, targetId, after)
  return true
}

function applyCombine(state: RailState, instruction: RailInstruction): string | null {
  if (instruction.source.kind !== "server") return "folders cannot combine"
  const sourceId = instruction.source.id
  const sourceFolder = folderForServer(state, sourceId)
  if (instruction.target.kind === "folder") {
    const targetItems = state.folders[instruction.target.id]
    if (!targetItems) return "target folder is missing"
    if (sourceFolder === instruction.target.id) return "server is already in target folder"
    removeServerFromFolder(state, sourceId)
    state.folders[instruction.target.id] = [...targetItems, sourceId]
    state.expanded = unique([...state.expanded, instruction.target.id])
    return null
  }

  const targetId = instruction.target.id
  const targetFolder = folderForServer(state, targetId)
  if (targetFolder) {
    if (sourceFolder === targetFolder) return "servers already share a folder"
    removeServerFromFolder(state, sourceId)
    const targetItems = state.folders[targetFolder]!
    const targetIndex = targetItems.indexOf(targetId)
    state.folders[targetFolder] = [...targetItems]
    state.folders[targetFolder]!.splice(targetIndex + 1, 0, sourceId)
    state.expanded = unique([...state.expanded, targetFolder])
    return null
  }
  if (sourceFolder) return "creating a folder requires two top-level servers"
  if (state.folderOrder.length >= MAX_SERVER_RAIL_FOLDERS) return "folder limit reached"
  if (!instruction.newFolderId || state.folders[instruction.newFolderId]) {
    return "new folder id is required"
  }
  state.folderOrder.push(instruction.newFolderId)
  state.folders[instruction.newFolderId] = [sourceId, targetId]
  state.expanded = unique([...state.expanded, instruction.newFolderId])
  return null
}

export function planRailPersistence(before: RailState, after: RailState): ServerRailCommand[] {
  if (samePersistedState(before, after)) return []
  const commands: ServerRailCommand[] = []
  if (!sameArray(before.serverOrder, after.serverOrder)) {
    commands.push({ kind: "reorder-servers", serverIds: [...after.serverOrder] })
  }
  const added = after.folderOrder.filter((folderId) => !before.folderOrder.includes(folderId))
  for (const folderId of before.folderOrder) {
    const afterItems = after.folders[folderId]
    if (!afterItems) commands.push({ kind: "delete-folder", folderId })
    else if (!sameArray(before.folders[folderId] ?? [], afterItems)) {
      commands.push({ kind: "replace-folder-items", folderId, serverIds: [...afterItems] })
    }
  }
  if (added.length === 1) {
    const clientId = added[0]!
    commands.push({
      kind: "create-folder",
      clientId,
      name: "Group",
      serverIds: [...after.folders[clientId]!],
    })
  }
  const sameFolderSet = before.folderOrder.length === after.folderOrder.length
    && before.folderOrder.every((folderId) => after.folderOrder.includes(folderId))
  if (sameFolderSet && !sameArray(before.folderOrder, after.folderOrder)) {
    commands.push({ kind: "reorder-folders", folderIds: [...after.folderOrder] })
  }
  return commands
}

export function commitRailInstruction(
  before: RailState,
  instruction: RailInstruction,
): RailCommitResult {
  if (railStateErrors(before).length > 0) {
    return { applied: false, state: before, reason: "invalid start state" }
  }
  if (
    instruction.source.kind === instruction.target.kind
    && instruction.source.id === instruction.target.id
  ) {
    return { applied: false, state: before, reason: "source equals target" }
  }
  const next = cloneRailState(before)
  let error: string | null = null
  if (instruction.operation === "combine") {
    error = applyCombine(next, instruction)
  } else if (instruction.source.kind === "folder" || instruction.target.kind === "folder") {
    if (instruction.source.kind !== "folder" || instruction.target.kind !== "folder") {
      error = "server and folder orders cannot interleave"
    } else if (!next.folderOrder.includes(instruction.source.id)
      || !next.folderOrder.includes(instruction.target.id)) {
      error = "folder is missing"
    } else {
      next.folderOrder = moveRelative(
        next.folderOrder,
        instruction.source.id,
        instruction.target.id,
        instruction.operation === "reorder-after",
      )
    }
  } else if (!next.serverOrder.includes(instruction.source.id)
    || !next.serverOrder.includes(instruction.target.id)) {
    error = "server is missing"
  } else {
    moveServerRelative(
      next,
      instruction.source.id,
      instruction.target.id,
      instruction.operation === "reorder-after",
    )
  }
  if (error) return { applied: false, state: before, reason: error }
  const stateError = railStateErrors(next)[0]
  if (stateError) return { applied: false, state: before, reason: stateError }
  const commands = planRailPersistence(before, next)
  if (commands.length === 0) return { applied: false, state: before, reason: "instruction is a no-op" }
  if (commands.length > 3) return { applied: false, state: before, reason: "instruction exceeds command budget" }
  return { applied: true, state: next, commands }
}

function previewInstruction(instruction: RailInstruction, state: RailState): RailInstruction {
  if (
    instruction.operation !== "combine"
    || instruction.source.kind !== "server"
    || instruction.target.kind !== "server"
    || instruction.newFolderId
  ) return instruction
  let suffix = 0
  let newFolderId = "__rail_preview_folder__"
  while (state.folders[newFolderId]) {
    suffix += 1
    newFolderId = `__rail_preview_folder_${suffix}__`
  }
  return { ...instruction, newFolderId }
}

export function railInstructionIsAvailable(
  state: RailState,
  instruction: RailInstruction,
): boolean {
  return commitRailInstruction(state, previewInstruction(instruction, state)).applied
}

export function railOperationAvailability(
  state: RailState,
  source: RailEntity | null,
  target: RailEntity,
): RailOperationAvailability {
  if (!source) {
    return { "reorder-before": false, "reorder-after": false, combine: false }
  }
  return {
    "reorder-before": railInstructionIsAvailable(state, {
      operation: "reorder-before",
      source,
      target,
    }),
    "reorder-after": railInstructionIsAvailable(state, {
      operation: "reorder-after",
      source,
      target,
    }),
    combine: railInstructionIsAvailable(state, { operation: "combine", source, target }),
  }
}

export function railMoveAnnouncement(
  instruction: RailInstruction,
  names: { servers: ReadonlyMap<string, string>; folders: ReadonlyMap<string, string> },
): string {
  const source = instruction.source.kind === "server"
    ? names.servers.get(instruction.source.id) ?? "Server"
    : names.folders.get(instruction.source.id) ?? "Group"
  const target = instruction.target.kind === "server"
    ? names.servers.get(instruction.target.id) ?? "server"
    : names.folders.get(instruction.target.id) ?? "group"
  if (instruction.operation === "combine") return `${source} moved into ${target}`
  return `${source} moved ${instruction.operation === "reorder-before" ? "before" : "after"} ${target}`
}
