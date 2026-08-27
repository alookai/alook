import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element"
import {
  attachInstruction,
  extractInstruction,
  type Availability,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item"
import { announce, cleanup as cleanupLiveRegion } from "@atlaskit/pragmatic-drag-and-drop-live-region"
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter"
import {
  accessibleMoveLabel,
  cloneState,
  commitInstruction,
  folderForServer,
  planPersistence,
  visibleTopLevelServers,
  type Entity,
  type PersistenceCommand,
  type RailInstruction,
  type RailState,
} from "./rail-model"
import "./styles.css"

type EventEntry = {
  index: number
  type: string
  instruction?: RailInstruction
  commands?: PersistenceCommand[]
  detail?: string
}

type SpikeReadout = {
  state: RailState
  events: EventEntry[]
  clickCount: number
  commitCount: number
  persistenceBatchCount: number
  rollbackCount: number
  failNext: boolean
  preview: RailInstruction | null
}

declare global {
  interface Window {
    __railSpike: {
      read: () => SpikeReadout
      reset: () => void
      failNextPersistence: () => void
    }
  }
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`missing element ${selector}`)
  return element
}

const app = requiredElement("#app")
const eventOutput = requiredElement("#events")

function makeFixture(): RailState {
  return {
    serverOrder: Array.from({ length: 18 }, (_, index) => String.fromCharCode(97 + index)),
    folderOrder: ["one", "two"],
    folders: { one: ["c", "d"], two: ["e", "f"] },
    expanded: ["one"],
  }
}

let state = makeFixture()
let events: EventEntry[] = []
let clickCount = 0
let commitCount = 0
let persistenceBatchCount = 0
let rollbackCount = 0
let failNext = false
let preview: RailInstruction | null = null
let dragStartSnapshot: RailState | null = null
let dragSource: Entity | null = null
let folderSequence = 0
let interactionCleanups: Array<() => void> = []
let hoverTimer: number | null = null
let hoverFolderId: string | null = null
const transientCollapsed = new Set<string>()
const transientExpanded = new Set<string>()

function entityKey(entity: Entity): string {
  return `${entity.kind}-${entity.id}`
}

function sameEntity(left: Entity | null, right: Entity | null): boolean {
  return left?.kind === right?.kind && left?.id === right?.id
}

function entityFromData(data: Record<string | symbol, unknown>): Entity | null {
  const kind = data.railKind
  const id = data.railId
  if ((kind !== "server" && kind !== "folder") || typeof id !== "string") return null
  return { kind, id }
}

function record(type: string, values: Omit<EventEntry, "index" | "type"> = {}): void {
  events.push({ index: events.length + 1, type, ...values })
  eventOutput.textContent = JSON.stringify(events, null, 2)
}

function readout(): SpikeReadout {
  return {
    state: cloneState(state),
    events: structuredClone(events),
    clickCount,
    commitCount,
    persistenceBatchCount,
    rollbackCount,
    failNext,
    preview: preview ? structuredClone(preview) : null,
  }
}

function clearHoverTimer(): void {
  if (hoverTimer !== null) window.clearTimeout(hoverTimer)
  hoverTimer = null
  hoverFolderId = null
}

function effectiveExpanded(folderId: string): boolean {
  if (transientCollapsed.has(folderId)) return false
  return state.expanded.includes(folderId) || transientExpanded.has(folderId)
}

function setFolderChildrenVisibility(folderId: string): void {
  const element = document.querySelector<HTMLElement>(`[data-folder-children="${folderId}"]`)
  if (element) element.hidden = !effectiveExpanded(folderId)
  const row = document.querySelector<HTMLElement>(`[data-testid="rail-item-folder-${folderId}"]`)
  row?.setAttribute("aria-expanded", String(effectiveExpanded(folderId)))
}

function resetTransientDragState(): void {
  clearHoverTimer()
  preview = null
  dragStartSnapshot = null
  dragSource = null
  transientCollapsed.clear()
  transientExpanded.clear()
}

function focusEntity(entity: Entity): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-testid="primary-${entityKey(entity)}"]`)?.focus()
  })
}

function finishCommit(
  before: RailState,
  instruction: RailInstruction,
  source: "pointer" | "move-menu",
): void {
  const committed = commitInstruction(before, instruction)
  if (!committed.applied) {
    record("invalid-drop", { instruction, detail: committed.reason })
    render(instruction.source)
    return
  }

  const commands = planPersistence(before, committed.state, instruction)
  const shouldFail = failNext
  failNext = false
  state = committed.state
  commitCount += 1
  persistenceBatchCount += 1
  record("optimistic-commit", { instruction, commands, detail: source })
  render(instruction.source)

  window.setTimeout(() => {
    if (shouldFail) {
      state = cloneState(before)
      rollbackCount += 1
      record("rollback", { instruction, commands })
      announce(`${accessibleMoveLabel(before, instruction)} failed and was rolled back`)
      render(instruction.source)
      return
    }
    const label = accessibleMoveLabel(before, instruction)
    record("persisted", { instruction, commands, detail: label })
    announce(label)
    focusEntity(instruction.source)
  }, 80)
}

function instructionWithFolderId(instruction: RailInstruction, before: RailState): RailInstruction {
  if (
    instruction.operation !== "combine"
    || instruction.source.kind !== "server"
    || instruction.target.kind !== "server"
    || folderForServer(before, instruction.source.id)
    || folderForServer(before, instruction.target.id)
  ) {
    return instruction
  }
  folderSequence += 1
  return { ...instruction, newFolderId: `temporary-${folderSequence}` }
}

function instructionFromDropTargets(
  sourceData: Record<string | symbol, unknown>,
  targets: readonly { data: Record<string | symbol, unknown> }[],
): RailInstruction | null {
  const source = entityFromData(sourceData)
  const targetRecord = targets[0]
  if (!source || !targetRecord) return null
  const target = entityFromData(targetRecord.data)
  const hitbox = extractInstruction(targetRecord.data)
  if (!target || !hitbox || hitbox.blocked || sameEntity(source, target)) return null
  return { operation: hitbox.operation, source, target }
}

function sameInstruction(left: RailInstruction | null, right: RailInstruction | null): boolean {
  return left?.operation === right?.operation
    && sameEntity(left?.source ?? null, right?.source ?? null)
    && sameEntity(left?.target ?? null, right?.target ?? null)
}

function clearPreviewClasses(): void {
  for (const element of document.querySelectorAll<HTMLElement>(".preview-before, .preview-after, .preview-combine")) {
    element.classList.remove("preview-before", "preview-after", "preview-combine")
  }
}

function updateHoverExpansion(instruction: RailInstruction | null): void {
  const folderId = instruction?.operation === "combine" && instruction.target.kind === "folder"
    ? instruction.target.id
    : null
  if (!folderId || effectiveExpanded(folderId)) {
    clearHoverTimer()
    return
  }
  if (hoverFolderId === folderId && hoverTimer !== null) return
  clearHoverTimer()
  hoverFolderId = folderId
  hoverTimer = window.setTimeout(() => {
    transientExpanded.add(folderId)
    setFolderChildrenVisibility(folderId)
    record("hover-expand", { detail: folderId })
    hoverTimer = null
  }, 500)
}

function updatePreview(
  sourceData: Record<string | symbol, unknown>,
  targets: readonly { data: Record<string | symbol, unknown> }[],
): void {
  const next = instructionFromDropTargets(sourceData, targets)
  if (sameInstruction(preview, next)) return
  preview = next
  clearPreviewClasses()
  if (next) {
    const target = document.querySelector<HTMLElement>(`[data-testid="rail-item-${entityKey(next.target)}"]`)
    target?.classList.add(
      next.operation === "reorder-before"
        ? "preview-before"
        : next.operation === "reorder-after"
          ? "preview-after"
          : "preview-combine",
    )
    record("preview", { instruction: next })
  } else {
    record("preview-cleared")
  }
  updateHoverExpansion(next)
}

function operationAvailability(source: Entity | null, target: Entity): {
  "reorder-before": Availability
  "reorder-after": Availability
  combine: Availability
} {
  const canReorder = source?.kind === target.kind
  const canCombine = source?.kind === "server" && (target.kind === "folder" || target.kind === "server")
  return {
    "reorder-before": canReorder ? "available" : "not-available",
    "reorder-after": canReorder ? "available" : "not-available",
    combine: canCombine ? "available" : "not-available",
  }
}

function makeMoveOption(
  label: string,
  testId: string,
  instruction: RailInstruction,
  container: HTMLElement,
): void {
  const button = document.createElement("button")
  button.type = "button"
  button.role = "menuitem"
  button.dataset.testid = testId
  button.textContent = label
  button.addEventListener("click", () => {
    finishCommit(cloneState(state), instructionWithFolderId(instruction, state), "move-menu")
  })
  container.append(button)
}

function buildMoveMenu(entity: Entity): HTMLElement {
  const menu = document.createElement("div")
  menu.className = "move-menu"
  menu.role = "menu"
  menu.hidden = true
  menu.dataset.testid = `move-menu-${entityKey(entity)}`

  if (entity.kind === "folder") {
    for (const targetId of state.folderOrder.filter((id) => id !== entity.id)) {
      for (const operation of ["reorder-before", "reorder-after"] as const) {
        makeMoveOption(
          `Move ${operation === "reorder-before" ? "before" : "after"} folder ${targetId}`,
          `move-${entityKey(entity)}-${operation}-${targetId}`,
          { operation, source: entity, target: { kind: "folder", id: targetId } },
          menu,
        )
      }
    }
    return menu
  }

  for (const targetId of state.serverOrder.filter((id) => id !== entity.id)) {
    for (const operation of ["reorder-before", "reorder-after"] as const) {
      makeMoveOption(
        `Move ${operation === "reorder-before" ? "before" : "after"} server ${targetId}`,
        `move-${entityKey(entity)}-${operation}-${targetId}`,
        { operation, source: entity, target: { kind: "server", id: targetId } },
        menu,
      )
    }
  }
  for (const folderId of state.folderOrder) {
    makeMoveOption(
      `Move into folder ${folderId}`,
      `move-${entityKey(entity)}-into-${folderId}`,
      { operation: "combine", source: entity, target: { kind: "folder", id: folderId } },
      menu,
    )
  }
  for (const targetId of visibleTopLevelServers(state).filter((id) => id !== entity.id)) {
    makeMoveOption(
      `Combine with server ${targetId}`,
      `move-${entityKey(entity)}-combine-${targetId}`,
      { operation: "combine", source: entity, target: { kind: "server", id: targetId } },
      menu,
    )
  }
  return menu
}

function renderRow(entity: Entity, parentFolderId: string | null): HTMLElement {
  const row = document.createElement("div")
  row.className = "rail-row"
  row.dataset.testid = `rail-item-${entityKey(entity)}`
  row.dataset.level = parentFolderId ? "1" : "0"
  if (entity.kind === "folder") row.setAttribute("aria-expanded", String(effectiveExpanded(entity.id)))

  const primary = document.createElement("button")
  primary.type = "button"
  primary.className = "primary-action"
  primary.dataset.testid = `primary-${entityKey(entity)}`
  primary.textContent = entity.kind === "server" ? `Server ${entity.id}` : `Folder ${entity.id}`
  primary.addEventListener("click", () => {
    clickCount += 1
    record("click", { detail: entityKey(entity) })
    if (entity.kind === "folder") {
      state.expanded = state.expanded.includes(entity.id)
        ? state.expanded.filter((id) => id !== entity.id)
        : [...state.expanded, entity.id]
      render(entity)
    }
  })

  const moveTrigger = document.createElement("button")
  moveTrigger.type = "button"
  moveTrigger.className = "move-trigger"
  moveTrigger.dataset.testid = `move-trigger-${entityKey(entity)}`
  moveTrigger.setAttribute("aria-haspopup", "menu")
  moveTrigger.textContent = "Move…"

  const menu = buildMoveMenu(entity)
  moveTrigger.addEventListener("click", () => {
    menu.hidden = !menu.hidden
    moveTrigger.setAttribute("aria-expanded", String(!menu.hidden))
  })

  row.append(primary, moveTrigger, menu)
  return row
}

function renderFolder(folderId: string): HTMLElement {
  const wrapper = document.createElement("section")
  wrapper.className = "folder"
  wrapper.append(renderRow({ kind: "folder", id: folderId }, null))
  const children = document.createElement("div")
  children.className = "folder-children"
  children.dataset.folderChildren = folderId
  children.hidden = !effectiveExpanded(folderId)
  for (const serverId of state.folders[folderId] ?? []) {
    children.append(renderRow({ kind: "server", id: serverId }, folderId))
  }
  wrapper.append(children)
  return wrapper
}

function wireInteractions(rail: HTMLElement): void {
  for (const cleanup of interactionCleanups.splice(0)) cleanup()

  for (const row of rail.querySelectorAll<HTMLElement>(".rail-row")) {
    const kind = row.dataset.testid?.includes("-folder-") ? "folder" : "server"
    const id = row.dataset.testid?.split(`-${kind}-`)[1]
    const primary = row.querySelector<HTMLElement>(".primary-action")
    if (!id || !primary) continue
    const entity: Entity = { kind, id }

    interactionCleanups.push(draggable({
      element: row,
      dragHandle: primary,
      getInitialData: () => ({ railKind: entity.kind, railId: entity.id }),
    }))

    interactionCleanups.push(dropTargetForElements({
      element: row,
      canDrop: ({ source }) => !sameEntity(entityFromData(source.data), entity),
      getIsSticky: () => false,
      getData: ({ input, element, source }) => attachInstruction(
        { railKind: entity.kind, railId: entity.id },
        {
          input,
          element,
          axis: "vertical",
          operations: operationAvailability(entityFromData(source.data), entity),
        },
      ),
    }))
  }

  interactionCleanups.push(autoScrollForElements({
    element: rail,
    getAllowedAxis: () => "vertical",
    getConfiguration: () => ({ maxScrollSpeed: "fast" }),
  }))

  interactionCleanups.push(monitorForElements({
    canMonitor: ({ source }) => entityFromData(source.data) !== null,
    onDragStart: ({ source }) => {
      dragStartSnapshot = cloneState(state)
      dragSource = entityFromData(source.data)
      if (dragSource?.kind === "folder" && state.expanded.includes(dragSource.id)) {
        transientCollapsed.add(dragSource.id)
        setFolderChildrenVisibility(dragSource.id)
      }
      record("drag-start", { detail: dragSource ? entityKey(dragSource) : "unknown" })
    },
    onDrag: ({ source, location }) => {
      updatePreview(source.data, location.current.dropTargets)
    },
    onDropTargetChange: ({ source, location }) => {
      updatePreview(source.data, location.current.dropTargets)
    },
    onDrop: ({ source, location }) => {
      const before = dragStartSnapshot ? cloneState(dragStartSnapshot) : cloneState(state)
      const rawInstruction = instructionFromDropTargets(source.data, location.current.dropTargets)
      resetTransientDragState()
      clearPreviewClasses()
      if (!rawInstruction) {
        record("cancel")
        render(dragSource ?? undefined)
        return
      }
      finishCommit(before, instructionWithFolderId(rawInstruction, before), "pointer")
    },
  }))
}

function render(focusAfter?: Entity): void {
  const scrollTop = app.querySelector<HTMLElement>("[data-testid='rail-scroll']")?.scrollTop ?? 0
  app.replaceChildren()

  const controls = document.createElement("div")
  controls.className = "controls"
  const resetButton = document.createElement("button")
  resetButton.type = "button"
  resetButton.dataset.testid = "reset"
  resetButton.textContent = "Reset fixture"
  resetButton.addEventListener("click", resetFixture)
  const failureButton = document.createElement("button")
  failureButton.type = "button"
  failureButton.dataset.testid = "fail-next"
  failureButton.textContent = failNext ? "Next persistence will fail" : "Fail next persistence"
  failureButton.addEventListener("click", () => {
    failNext = true
    record("failure-armed")
    render(focusAfter)
  })
  controls.append(resetButton, failureButton)

  const rail = document.createElement("div")
  rail.className = "rail-scroll"
  rail.dataset.testid = "rail-scroll"
  rail.setAttribute("aria-label", "Server rail")
  for (const folderId of state.folderOrder) rail.append(renderFolder(folderId))
  for (const serverId of visibleTopLevelServers(state)) {
    rail.append(renderRow({ kind: "server", id: serverId }, null))
  }

  app.append(controls, rail)
  rail.scrollTop = scrollTop
  wireInteractions(rail)
  if (focusAfter) focusEntity(focusAfter)
}

function resetFixture(): void {
  state = makeFixture()
  events = []
  clickCount = 0
  commitCount = 0
  persistenceBatchCount = 0
  rollbackCount = 0
  failNext = false
  folderSequence = 0
  resetTransientDragState()
  eventOutput.textContent = "[]"
  render()
}

window.__railSpike = {
  read: readout,
  reset: resetFixture,
  failNextPersistence: () => {
    failNext = true
    record("failure-armed")
    render()
  },
}

window.addEventListener("pagehide", () => {
  for (const dispose of interactionCleanups) dispose()
  cleanupLiveRegion()
}, { once: true })

render()
