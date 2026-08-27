export const MAX_FOLDERS = 10

export type Entity =
  | { kind: "server"; id: string }
  | { kind: "folder"; id: string }

export type Operation = "reorder-before" | "reorder-after" | "combine"

export type RailInstruction = {
  operation: Operation
  source: Entity
  target: Entity
  newFolderId?: string
}

export type RailState = {
  serverOrder: string[]
  folderOrder: string[]
  folders: Record<string, string[]>
  expanded: string[]
}

export type PersistenceCommand =
  | { type: "reorder-servers"; serverIds: string[] }
  | { type: "reorder-folders"; folderIds: string[] }
  | { type: "update-folder"; folderId: string; serverIds: string[] }
  | { type: "create-folder"; tempFolderId: string; serverIds: string[] }

export type CommitResult = {
  state: RailState
  applied: boolean
  reason?: string
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function cloneState(state: RailState): RailState {
  return {
    serverOrder: [...state.serverOrder],
    folderOrder: [...state.folderOrder],
    folders: Object.fromEntries(
      Object.entries(state.folders).map(([folderId, serverIds]) => [folderId, [...serverIds]]),
    ),
    expanded: [...state.expanded],
  }
}

export function visibleTopLevelServers(state: RailState): string[] {
  const claimed = new Set(Object.values(state.folders).flat())
  return state.serverOrder.filter((serverId) => !claimed.has(serverId))
}

export function folderForServer(state: RailState, serverId: string): string | null {
  for (const folderId of state.folderOrder) {
    if (state.folders[folderId]?.includes(serverId)) return folderId
  }
  return null
}

export function stateErrors(state: RailState): string[] {
  const errors: string[] = []
  const serverSet = new Set(state.serverOrder)
  if (serverSet.size !== state.serverOrder.length) errors.push("serverOrder contains duplicates")
  if (new Set(state.folderOrder).size !== state.folderOrder.length) {
    errors.push("folderOrder contains duplicates")
  }
  if (state.folderOrder.length > MAX_FOLDERS) errors.push("folder limit exceeded")

  const memberships = new Set<string>()
  for (const folderId of state.folderOrder) {
    const items = state.folders[folderId]
    if (!items) {
      errors.push(`folder ${folderId} is missing`)
      continue
    }
    if (items.length === 0) errors.push(`folder ${folderId} is empty`)
    if (new Set(items).size !== items.length) errors.push(`folder ${folderId} contains duplicates`)
    for (const serverId of items) {
      if (!serverSet.has(serverId)) errors.push(`folder ${folderId} contains unknown server ${serverId}`)
      if (memberships.has(serverId)) errors.push(`server ${serverId} belongs to multiple folders`)
      memberships.add(serverId)
    }
  }
  for (const folderId of Object.keys(state.folders)) {
    if (!state.folderOrder.includes(folderId)) errors.push(`folder ${folderId} is not ordered`)
  }
  for (const folderId of state.expanded) {
    if (!state.folderOrder.includes(folderId)) errors.push(`expanded folder ${folderId} is missing`)
  }
  return errors
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function sameState(left: RailState, right: RailState): boolean {
  if (!sameArray(left.serverOrder, right.serverOrder)) return false
  if (!sameArray(left.folderOrder, right.folderOrder)) return false
  if (!sameArray(left.expanded, right.expanded)) return false
  return left.folderOrder.every((folderId) =>
    sameArray(left.folders[folderId] ?? [], right.folders[folderId] ?? []),
  )
}

function moveRelative(list: readonly string[], sourceId: string, targetId: string, after: boolean): string[] {
  const withoutSource = list.filter((id) => id !== sourceId)
  const targetIndex = withoutSource.indexOf(targetId)
  if (targetIndex === -1) return [...list]
  const next = [...withoutSource]
  next.splice(targetIndex + (after ? 1 : 0), 0, sourceId)
  return next
}

function removeEmptyFolder(state: RailState, folderId: string): void {
  if ((state.folders[folderId]?.length ?? 0) > 0) return
  delete state.folders[folderId]
  state.folderOrder = state.folderOrder.filter((id) => id !== folderId)
  state.expanded = state.expanded.filter((id) => id !== folderId)
}

function removeServerFromFolder(state: RailState, serverId: string): string | null {
  const folderId = folderForServer(state, serverId)
  if (!folderId) return null
  state.folders[folderId] = state.folders[folderId]!.filter((id) => id !== serverId)
  removeEmptyFolder(state, folderId)
  return folderId
}

function insertServerRelative(
  state: RailState,
  sourceId: string,
  targetId: string,
  after: boolean,
): boolean {
  const targetFolder = folderForServer(state, targetId)
  const sourceFolder = folderForServer(state, sourceId)
  if (sourceFolder === targetFolder) {
    if (targetFolder) {
      state.folders[targetFolder] = moveRelative(
        state.folders[targetFolder]!,
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
    const targetItems = state.folders[targetFolder]
    if (!targetItems) return false
    state.folders[targetFolder] = moveRelative(
      [...targetItems, sourceId],
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

function combineServer(state: RailState, instruction: RailInstruction): CommitResult {
  if (instruction.source.kind !== "server") {
    return { state, applied: false, reason: "folders cannot combine" }
  }
  const sourceId = instruction.source.id
  const sourceFolder = folderForServer(state, sourceId)

  if (instruction.target.kind === "folder") {
    const targetFolderId = instruction.target.id
    const targetItems = state.folders[targetFolderId]
    if (!targetItems) return { state, applied: false, reason: "target folder is missing" }
    if (sourceFolder === targetFolderId) {
      return { state, applied: false, reason: "server is already in target folder" }
    }
    removeServerFromFolder(state, sourceId)
    state.folders[targetFolderId] = [...targetItems, sourceId]
    state.expanded = unique([...state.expanded, targetFolderId])
    return { state, applied: true }
  }

  const targetId = instruction.target.id
  const targetFolder = folderForServer(state, targetId)
  if (targetFolder) {
    if (sourceFolder === targetFolder) {
      return { state, applied: false, reason: "servers already share a folder" }
    }
    removeServerFromFolder(state, sourceId)
    const targetItems = state.folders[targetFolder]
    if (!targetItems) return { state, applied: false, reason: "target folder is missing" }
    const targetIndex = targetItems.indexOf(targetId)
    state.folders[targetFolder] = [...targetItems]
    state.folders[targetFolder]!.splice(targetIndex + 1, 0, sourceId)
    state.expanded = unique([...state.expanded, targetFolder])
    return { state, applied: true }
  }

  if (sourceFolder) {
    return {
      state,
      applied: false,
      reason: "creating a folder requires two top-level servers",
    }
  }
  if (state.folderOrder.length >= MAX_FOLDERS) {
    return { state, applied: false, reason: "folder limit reached" }
  }
  const newFolderId = instruction.newFolderId
  if (!newFolderId || state.folders[newFolderId]) {
    return { state, applied: false, reason: "new folder id is required" }
  }
  state.folderOrder.push(newFolderId)
  state.folders[newFolderId] = [sourceId, targetId]
  state.expanded = unique([...state.expanded, newFolderId])
  return { state, applied: true }
}

export function commitInstruction(
  before: RailState,
  instruction: RailInstruction,
): CommitResult {
  if (stateErrors(before).length > 0) {
    return { state: before, applied: false, reason: "invalid start state" }
  }
  if (
    instruction.source.kind === instruction.target.kind
    && instruction.source.id === instruction.target.id
  ) {
    return { state: before, applied: false, reason: "source equals target" }
  }

  const next = cloneState(before)
  let result: CommitResult
  if (instruction.operation === "combine") {
    result = combineServer(next, instruction)
  } else if (instruction.source.kind === "folder" || instruction.target.kind === "folder") {
    if (instruction.source.kind !== "folder" || instruction.target.kind !== "folder") {
      return { state: before, applied: false, reason: "server and folder orders cannot interleave" }
    }
    if (!next.folderOrder.includes(instruction.source.id)
      || !next.folderOrder.includes(instruction.target.id)) {
      return { state: before, applied: false, reason: "folder is missing" }
    }
    next.folderOrder = moveRelative(
      next.folderOrder,
      instruction.source.id,
      instruction.target.id,
      instruction.operation === "reorder-after",
    )
    result = { state: next, applied: true }
  } else {
    if (!next.serverOrder.includes(instruction.source.id)
      || !next.serverOrder.includes(instruction.target.id)) {
      return { state: before, applied: false, reason: "server is missing" }
    }
    const applied = insertServerRelative(
      next,
      instruction.source.id,
      instruction.target.id,
      instruction.operation === "reorder-after",
    )
    result = applied
      ? { state: next, applied: true }
      : { state: before, applied: false, reason: "target is missing" }
  }

  if (!result.applied) return { ...result, state: before }
  const errors = stateErrors(result.state)
  if (errors.length > 0) {
    return { state: before, applied: false, reason: errors.join("; ") }
  }
  if (sameState(before, result.state)) {
    return { state: before, applied: false, reason: "instruction is a no-op" }
  }
  return result
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((value) => set.has(value))
}

export function planPersistence(
  before: RailState,
  after: RailState,
  instruction: RailInstruction,
): PersistenceCommand[] {
  if (sameState(before, after)) return []
  const commands: PersistenceCommand[] = []

  if (!sameArray(before.serverOrder, after.serverOrder)) {
    commands.push({ type: "reorder-servers", serverIds: [...after.serverOrder] })
  }

  const addedFolders = after.folderOrder.filter((folderId) => !before.folderOrder.includes(folderId))
  const removedFolders = before.folderOrder.filter((folderId) => !after.folderOrder.includes(folderId))
  if (addedFolders.length === 1 && instruction.operation === "combine") {
    const folderId = addedFolders[0]!
    commands.push({
      type: "create-folder",
      tempFolderId: folderId,
      serverIds: [...after.folders[folderId]!],
    })
  }

  for (const folderId of before.folderOrder) {
    const beforeItems = before.folders[folderId] ?? []
    const afterItems = after.folders[folderId]
    if (!afterItems) {
      commands.push({ type: "update-folder", folderId, serverIds: [] })
    } else if (!sameArray(beforeItems, afterItems)) {
      commands.push({ type: "update-folder", folderId, serverIds: [...afterItems] })
    }
  }

  const sameFolderSet = sameMembers(before.folderOrder, after.folderOrder)
  if (sameFolderSet && !sameArray(before.folderOrder, after.folderOrder)) {
    commands.push({ type: "reorder-folders", folderIds: [...after.folderOrder] })
  }

  return commands
}

export function accessibleMoveLabel(
  state: RailState,
  instruction: RailInstruction,
): string {
  const source = instruction.source.kind === "server"
    ? `Server ${instruction.source.id}`
    : `Folder ${instruction.source.id}`
  if (instruction.operation === "combine") {
    const target = instruction.target.kind === "server"
      ? `server ${instruction.target.id}`
      : `folder ${instruction.target.id}`
    return `${source} moved into ${target}`
  }
  const placement = instruction.operation === "reorder-before" ? "before" : "after"
  const target = instruction.target.kind === "server"
    ? `server ${instruction.target.id}`
    : `folder ${instruction.target.id}`
  const sourceFolder = instruction.source.kind === "server"
    ? folderForServer(state, instruction.source.id)
    : null
  return `${source} moved ${placement} ${target}${sourceFolder ? ` from folder ${sourceFolder}` : ""}`
}
