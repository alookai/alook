import { MAX_SERVER_RAIL_FOLDERS, serverRailTopOrder, type ServerRailCommand, type ServerRailEntry } from "@alook/shared"
import type { CommunityFolder } from "@/lib/community/models/navigation"

export type RailEntity = ServerRailEntry
export type RailContainer = { kind: "root"; id: "root" } | { kind: "folder-content"; id: string }
export type RailOperation = "reorder-before" | "reorder-after" | "combine"
export type RailOperationAvailability = Record<RailOperation, boolean>
export type RailInstruction = {
  operation: RailOperation
  source: RailEntity
  target: RailEntity
  newFolderId?: string
} | {
  operation: "append"
  source: RailEntity
  target: RailContainer
  newFolderId?: never
}
export type RailState = {
  serverIds: string[]
  folderIds: string[]
  folders: Record<string, string[]>
  expanded: string[]
  topOrder?: RailEntity[]
}
export type RailCommitResult =
  | { applied: true; state: RailState; commands: ServerRailCommand[] }
  | { applied: false; state: RailState; reason: string }

const key = (entity: RailEntity) => `${entity.kind}:${entity.id}`
const sameArray = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index])
const unique = (values: string[]) => [...new Set(values)]

export function railTopLevel(state: RailState): RailEntity[] {
  return serverRailTopOrder({ ...state, folders: Object.fromEntries(Object.entries(state.folders).map(([id, serverIds]) => [id, { id, name: "", serverIds }])) })
}

export function railStateFromData(serverIds: readonly string[], folders: readonly CommunityFolder[], expanded: readonly string[], topOrder?: RailEntity[]): RailState {
  const membership = new Set(serverIds), claimed = new Set<string>()
  const projected = [...folders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((folder) => ({
    id: folder.id,
    ids: folder.servers.flatMap((server) => {
      if (!membership.has(server.id) || claimed.has(server.id)) return []
      claimed.add(server.id)
      return [server.id]
    }),
  })).filter((folder) => folder.ids.length > 0)
  const state: RailState = {
    serverIds: [...serverIds], folderIds: projected.map((folder) => folder.id),
    folders: Object.fromEntries(projected.map((folder) => [folder.id, folder.ids])),
    expanded: expanded.filter((id) => projected.some((folder) => folder.id === id)),
    ...(topOrder ? { topOrder } : {}),
  }
  if (topOrder) state.topOrder = railTopLevel(state)
  return state
}

export function cloneRailState(state: RailState): RailState {
  return {
    serverIds: [...state.serverIds], folderIds: [...state.folderIds],
    folders: Object.fromEntries(Object.entries(state.folders).map(([id, ids]) => [id, [...ids]])),
    expanded: [...state.expanded],
    ...(state.topOrder ? { topOrder: state.topOrder.map((entry) => ({ ...entry })) } : {}),
  }
}

function folderForServer(state: RailState, id: string): string | null {
  return state.folderIds.find((folderId) => state.folders[folderId]?.includes(id)) ?? null
}
export function visibleTopLevelServers(state: RailState): string[] {
  return railTopLevel(state).flatMap((entry) => entry.kind === "server" ? [entry.id] : [])
}
export function railStateErrors(state: RailState): string[] {
  const errors: string[] = []
  const servers = new Set(state.serverIds), claimed = new Set<string>()
  if (servers.size !== state.serverIds.length) errors.push("server order contains duplicates")
  if (new Set(state.folderIds).size !== state.folderIds.length) errors.push("folder order contains duplicates")
  if (state.folderIds.length > MAX_SERVER_RAIL_FOLDERS) errors.push("folder limit reached")
  for (const id of state.folderIds) {
    const items = state.folders[id]
    if (!items) { errors.push(`folder ${id} is missing`); continue }
    if (!items.length) errors.push(`folder ${id} is empty`)
    if (new Set(items).size !== items.length) errors.push(`folder ${id} contains duplicates`)
    for (const serverId of items) {
      if (!servers.has(serverId)) errors.push(`folder ${id} contains unknown server`)
      if (claimed.has(serverId)) errors.push(`server ${serverId} belongs to multiple folders`)
      claimed.add(serverId)
    }
  }
  for (const id of Object.keys(state.folders)) if (!state.folderIds.includes(id)) errors.push(`folder ${id} is unordered`)
  return errors
}
function removeServerFromFolder(state: RailState, id: string) {
  const folderId = folderForServer(state, id)
  if (!folderId) return
  state.folders[folderId] = state.folders[folderId]!.filter((serverId) => serverId !== id)
  if (state.folders[folderId]!.length) return
  delete state.folders[folderId]
  state.folderIds = state.folderIds.filter((value) => value !== folderId)
  state.expanded = state.expanded.filter((value) => value !== folderId)
}
function moveRelative(list: string[], source: string, target: string, after: boolean) {
  const next = list.filter((id) => id !== source)
  const index = next.indexOf(target)
  if (index < 0) return list
  next.splice(index + (after ? 1 : 0), 0, source)
  return next
}
function moveTopRelative(state: RailState, source: RailEntity, target: RailEntity, after: boolean) {
  const entries = railTopLevel(state).filter((entry) => key(entry) !== key(source))
  const index = entries.findIndex((entry) => key(entry) === key(target))
  if (index < 0) return false
  entries.splice(index + (after ? 1 : 0), 0, source)
  state.topOrder = entries
  return true
}

function combine(state: RailState, instruction: Extract<RailInstruction, { operation: RailOperation }>): string | null {
  if (instruction.source.kind !== "server") return "folders cannot combine"
  const source = instruction.source.id
  const sourceFolder = folderForServer(state, source)
  const targetFolder = instruction.target.kind === "folder" ? instruction.target.id : folderForServer(state, instruction.target.id)
  if (targetFolder) {
    if (!state.folders[targetFolder]) return "target folder is missing"
    if (sourceFolder === targetFolder) {
      if (instruction.target.kind !== "folder") return "server is already in target folder"
      state.folders[targetFolder] = [...state.folders[targetFolder]!.filter((id) => id !== source), source]
      return null
    }
    removeServerFromFolder(state, source)
    const items = state.folders[targetFolder]!
    const index = instruction.target.kind === "server" ? items.indexOf(instruction.target.id) + 1 : items.length
    items.splice(index, 0, source)
    return null
  }
  if (instruction.target.kind !== "server") return "target folder is missing"
  removeServerFromFolder(state, source)
  if (state.folderIds.length >= MAX_SERVER_RAIL_FOLDERS) return "folder limit reached"
  const id = instruction.newFolderId
  if (!id || state.folders[id]) return "new folder id is required"
  const entries = railTopLevel(state).filter((entry) => !(entry.kind === "server" && entry.id === source))
  const index = entries.findIndex((entry) => entry.kind === "server" && entry.id === instruction.target.id)
  if (index < 0) return "target server is missing"
  entries.splice(index, 1, { kind: "folder", id })
  state.topOrder = entries
  state.folderIds.push(id)
  state.folders[id] = [instruction.target.id, source]
  state.expanded = unique([...state.expanded, id])
  return null
}

export function planRailPersistence(before: RailState, after: RailState): ServerRailCommand[] {
  const commands: ServerRailCommand[] = []
  for (const id of before.folderIds) {
    if (!after.folders[id]) commands.push({ kind: "delete-folder", folderId: id })
    else if (!sameArray(before.folders[id] ?? [], after.folders[id]!)) commands.push({ kind: "replace-folder-items", folderId: id, serverIds: [...after.folders[id]!] })
  }
  for (const id of after.folderIds.filter((folderId) => !before.folders[folderId])) commands.push({ kind: "create-folder", clientId: id, name: "Group", serverIds: [...after.folders[id]!] })
  const topOrder = railTopLevel(after)
  if (!sameArray(railTopLevel(before).map(key), topOrder.map(key))) commands.push({ kind: "reorder-top-level", entries: topOrder })
  return commands
}

export function commitRailInstruction(before: RailState, instruction: RailInstruction): RailCommitResult {
  if (railStateErrors(before).length) return { applied: false, state: before, reason: "invalid start state" }
  const { source, target } = instruction
  if (source.kind === target.kind && source.id === target.id) return { applied: false, state: before, reason: "source equals target" }
  const exists = source.kind === "server" ? before.serverIds.includes(source.id) : before.folderIds.includes(source.id)
  if (!exists) return { applied: false, state: before, reason: "source is missing" }
  const next = cloneRailState(before)
  next.topOrder = railTopLevel(before)
  let error: string | null = null
  if (instruction.operation === "append") {
    if (instruction.target.kind === "root") {
      if (source.kind === "server") removeServerFromFolder(next, source.id)
      next.topOrder = [...railTopLevel(next).filter((entry) => key(entry) !== key(source)), source]
    } else if (source.kind !== "server") error = "folders cannot nest"
    else if (!next.folders[instruction.target.id]) error = "target folder is missing"
    else {
      const id = instruction.target.id
      if (folderForServer(next, source.id) === id) next.folders[id] = [...next.folders[id]!.filter((value) => value !== source.id), source.id]
      else { removeServerFromFolder(next, source.id); next.folders[id]!.push(source.id) }
    }
  } else if (instruction.operation === "combine") error = combine(next, instruction)
  else {
    const targetFolder = instruction.target.kind === "server" ? folderForServer(next, target.id) : null
    if (targetFolder) {
      if (source.kind !== "server") error = "folders cannot nest"
      else {
        if (folderForServer(next, source.id) !== targetFolder) {
          removeServerFromFolder(next, source.id)
          next.folders[targetFolder]!.push(source.id)
        }
        next.folders[targetFolder] = moveRelative(next.folders[targetFolder]!, source.id, target.id, instruction.operation === "reorder-after")
      }
    } else {
      const targetIndex = railTopLevel(next).findIndex((entry) => key(entry) === key(instruction.target))
      if (source.kind === "server") removeServerFromFolder(next, source.id)
      if (targetIndex >= 0 && instruction.target.kind === "folder" && !next.folders[instruction.target.id]) {
        const entries = railTopLevel(next).filter((entry) => key(entry) !== key(source))
        entries.splice(targetIndex, 0, source)
        next.topOrder = entries
      } else if (!moveTopRelative(next, source, instruction.target, instruction.operation === "reorder-after")) error = "target is missing"
    }
  }
  if (error) return { applied: false, state: before, reason: error }
  next.topOrder = railTopLevel(next)
  const stateError = railStateErrors(next)[0]
  if (stateError) return { applied: false, state: before, reason: stateError }
  const commands = planRailPersistence(before, next)
  if (!commands.length) return { applied: false, state: before, reason: "instruction is a no-op" }
  if (commands.length > 3) return { applied: false, state: before, reason: "instruction exceeds command budget" }
  return { applied: true, state: next, commands }
}

export function railInstructionIsAvailable(state: RailState, instruction: RailInstruction) {
  let id = "__rail_preview_folder__", suffix = 0
  while (state.folders[id]) id = `__rail_preview_folder_${++suffix}__`
  const preview = instruction.operation === "combine" && instruction.source.kind === "server" && instruction.target.kind === "server" && !instruction.newFolderId
    ? { ...instruction, newFolderId: id }
    : instruction
  return commitRailInstruction(state, preview).applied
}
export function railOperationAvailability(state: RailState, source: RailEntity | null, target: RailEntity): RailOperationAvailability {
  return {
    "reorder-before": !!source && railInstructionIsAvailable(state, { operation: "reorder-before", source, target }),
    "reorder-after": !!source && railInstructionIsAvailable(state, { operation: "reorder-after", source, target }),
    combine: !!source && railInstructionIsAvailable(state, { operation: "combine", source, target }),
  }
}
export function railMoveAnnouncement(instruction: RailInstruction, names: { servers: ReadonlyMap<string, string>; folders: ReadonlyMap<string, string> }): string {
  const source = instruction.source.kind === "server" ? names.servers.get(instruction.source.id) ?? "Server" : names.folders.get(instruction.source.id) ?? "Group"
  if (instruction.operation === "append") return `${source} moved to the end of ${instruction.target.kind === "root" ? "the server list" : names.folders.get(instruction.target.id) ?? "group"}`
  const target = instruction.target.kind === "server" ? names.servers.get(instruction.target.id) ?? "server" : names.folders.get(instruction.target.id) ?? "group"
  return instruction.operation === "combine" ? `${source} moved into ${target}` : `${source} moved ${instruction.operation === "reorder-before" ? "before" : "after"} ${target}`
}
