import { useLayoutEffect } from "react"
import { useDragDropManager } from "react-dnd"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, mockElementGeometry, render } from "@/test/react-dom-harness"
import { CommunityDndProvider, communityTouchHoldDelay } from "./community-dnd"
import { SortableServer } from "./shell/sortable-server"
import { useServerRailDnd } from "./shell/use-server-rail-dnd"
import { ChannelDndScope } from "./channels/channel-dnd"
import { SortableChannel } from "./channels/sortable-channel"
import { SortableCategory } from "./channels/sortable-category"
import { useChannelTree, type ChannelTreeDrop } from "./channels/use-channel-tree"
import type { RailInstruction } from "@/lib/community/server-rail-model"
import { tid } from "@/lib/community/testids"

type Kind = "server" | "channel" | "category"
type DragDropManager = ReturnType<typeof useDragDropManager>
const views: Array<{ unmount: () => void }> = []
const pointMethods = ["elementFromPoint", "elementsFromPoint"] as const
const originals = pointMethods.map(key => Object.getOwnPropertyDescriptor(document, key))

afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  pointMethods.forEach((key, index) => {
    const original = originals[index]
    if (original) Object.defineProperty(document, key, original)
    else Reflect.deleteProperty(document, key)
  })
})

function Probe({ ready }: { ready: (manager: DragDropManager) => void }) {
  const manager = useDragDropManager()
  useLayoutEffect(() => { ready(manager) }, [manager, ready])
  return null
}

function Rail({ drop, activate, menuAction, enabled }: { drop: (instruction: RailInstruction) => void; activate: () => void; menuAction: () => void; enabled: boolean }) {
  const dnd = useServerRailDnd({ getState: () => ({ serverIds: ["a", "b"], folderIds: [], folders: {}, expanded: [] }), canStart: () => enabled, onDragStart: () => {}, onPreview: () => {}, onDrop: drop, onCancel: () => {} })
  return <>{["a", "b"].map(id => <SortableServer key={id} server={{ id, name: id, initial: id, active: false, unread: false, mentions: 0 }} onClick={activate} onOpenSettings={menuAction} dnd={dnd} />)}</>
}

function Tree({ kind, drop, activate, menuAction, enabled }: { kind: Exclude<Kind, "server">; drop: (event: ChannelTreeDrop) => void; activate: () => void; menuAction: () => void; enabled: boolean }) {
  const tree = useChannelTree([{ id: "category-a", name: "a", channels: [{ id: "channel-a", name: "a", unread: false, active: false }, { id: "channel-b", name: "b", unread: false, active: false }] }, { id: "category-b", name: "b", channels: [] }])
  return <ChannelDndScope tree={tree} onDrop={drop} enabled={enabled}>{[`${kind}-a`, `${kind}-b`].map(id => kind === "channel"
    ? <SortableChannel key={id} ch={{ id, name: id, unread: false, active: false }} active={false} onClick={activate} onEdit={menuAction} canReorder={enabled} />
    : <SortableCategory key={id} id={id} name={id} open onToggle={activate} onSettings={menuAction} canReorder={enabled} hasChannels>{null}</SortableCategory>)}</ChannelDndScope>
}

function EmptyChannelScope({ enabled }: { enabled: boolean }) {
  const tree = useChannelTree([])
  return <ChannelDndScope tree={tree} onDrop={() => {}} enabled={enabled}>{null}</ChannelDndScope>
}

function setup(kind: Kind, enabled = true, includeOtherScope = false) {
  vi.useFakeTimers()
  const drop = vi.fn(), activate = vi.fn(), menuAction = vi.fn()
  let manager!: DragDropManager
  const content = (enabled: boolean, otherEnabled = true) => <CommunityDndProvider><Probe ready={value => { manager = value }} />{kind === "server" ? <Rail drop={drop} activate={activate} menuAction={menuAction} enabled={enabled} /> : <Tree kind={kind} drop={drop} activate={activate} menuAction={menuAction} enabled={enabled} />}{includeOtherScope && <EmptyChannelScope enabled={otherEnabled} />}</CommunityDndProvider>
  const view = render(content(enabled))
  views.push(view)
  const testid = kind === "server" ? tid.serverIcon : kind === "channel" ? tid.channelRow : tid.categoryHeader
  const source = view.getByTestId(testid(kind === "server" ? "a" : `${kind}-a`)), target = view.getByTestId(testid(kind === "server" ? "b" : `${kind}-b`))
  mockElementGeometry(source, { top: 0, left: 0, width: 100, height: 40 })
  mockElementGeometry(target, { top: 100, left: 0, width: 100, height: 40 })
  if (kind === "category") {
    mockElementGeometry(source.parentElement!, { top: 0, left: 0, width: 100, height: 40 })
    mockElementGeometry(target.parentElement!, { top: 100, left: 0, width: 100, height: 40 })
  }
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (_x: number, y: number) => y >= 90 ? target : source })
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (_x: number, y: number) => [y >= 90 ? target : source] })
  const touch = (y: number) => ({ identifier: 1, clientX: 20, clientY: y, target: source })
  const start = () => {
    fireEvent.pointerDown(source, { pointerType: "touch", button: 0 })
    fireEvent.touchStart(source, { touches: [touch(20)], targetTouches: [touch(20)], changedTouches: [touch(20)] })
  }
  const move = (y: number) => fireEvent.touchMove(source, { touches: [touch(y)], targetTouches: [touch(y)], changedTouches: [touch(y)] })
  const end = () => fireEvent.touchEnd(source, { touches: [], targetTouches: [], changedTouches: [touch(120)] })
  const hold = async () => { await act(async () => { vi.advanceTimersByTime(communityTouchHoldDelay + 20) }) }
  return { ...view, manager, drop, activate, menuAction, source, start, move, end, hold, setEnabled: (next: boolean) => view.rerender(content(next)), setOtherEnabled: (next: boolean) => view.rerender(content(enabled, next)) }
}

describe("native community touch menu and drag handoff", () => {
  it.each<Exclude<Kind, "server">>(["channel", "category"])("finishes a %s drop once when saving disables reordering", async kind => {
    const ui = setup(kind)
    ui.drop.mockImplementationOnce(() => { ui.setEnabled(false) })
    ui.start()
    await ui.hold()
    ui.move(55)
    ui.move(130)
    ui.end()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).toHaveBeenCalledTimes(1)
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
  })

  it.each<Exclude<Kind, "server">>(["channel", "category"])("releases an active %s drag when permission changes and permits a new authorized gesture", async kind => {
    const ui = setup(kind)
    ui.start()
    await ui.hold()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    ui.setEnabled(false)
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.source).not.toHaveAttribute("data-dragging")
    expect(kind === "category" ? ui.source.parentElement : ui.source).toHaveStyle({ opacity: "1" })
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.move(130)
    ui.end()
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
    ui.setEnabled(true)
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    ui.move(130)
    ui.end()
    expect(ui.drop).toHaveBeenCalledTimes(1)
  })

  it("preserves another scope's native drag when a channel scope becomes disabled", async () => {
    const ui = setup("server", true, true)
    ui.start()
    await ui.hold()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    ui.setOtherEnabled(false)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    ui.move(130)
    ui.end()
    expect(ui.drop).toHaveBeenCalledTimes(1)
  })

  it.each((["server", "channel", "category"] as Kind[]).flatMap(kind =>
    (["drop", "cancel"] as const).flatMap(finish =>
      [{ key: "ContextMenu", shiftKey: false }, { key: "F10", shiftKey: true }].map(shortcut => ({ kind, finish, ...shortcut })))),
  )("opens the $kind menu with $key after native drag $finish without another pointer", async ({ kind, finish, key, shiftKey }) => {
    const ui = setup(kind)
    ui.start()
    await ui.hold()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    fireEvent.keyDown(ui.source, { key, shiftKey })
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    if (finish === "drop") {
      ui.move(130)
      ui.end()
    } else fireEvent.touchCancel(ui.source, { touches: [], targetTouches: [], changedTouches: [] })
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).toHaveBeenCalledTimes(finish === "drop" ? 1 : 0)
    fireEvent.contextMenu(ui.source, { button: 2 })
    fireEvent.click(ui.source)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.activate).not.toHaveBeenCalled()
    fireEvent.keyDown(ui.source, { key, shiftKey })
    expect(ui.getByRole("menu")).toBeInTheDocument()
    expect(ui.menuAction).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
  })

  it.each<Kind>(["server", "channel", "category"])("closes a held %s menu when the same touch starts dragging", async kind => {
    const ui = setup(kind)
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="context-menu-content"]')).toBeNull()
    fireEvent.contextMenu(ui.source, { button: 2 })
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.move(130)
    ui.end()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(ui.source, { button: 2 })
    fireEvent.click(ui.source)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.end()
  })

  it("leaves movement before the hold available for scrolling", async () => {
    const ui = setup("channel")
    ui.start()
    const moved = ui.move(26)
    await ui.hold()
    fireEvent.contextMenu(ui.source, { button: 2 })
    expect(moved).toBe(true)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    ui.end()
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
  })

  it("cancels an unfinished hold and permits the next touch", async () => {
    const ui = setup("category")
    ui.start()
    fireEvent.touchCancel(ui.source, { touches: [], targetTouches: [], changedTouches: [] })
    await ui.hold()
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.end()
    expect(ui.drop).not.toHaveBeenCalled()
  })

  it("keeps a menu-only hold open on release and prevents the synthesized navigation click", async () => {
    const ui = setup("channel")
    ui.start()
    await ui.hold()
    expect(ui.end()).toBe(false)
    expect(ui.getByRole("menu")).toBeInTheDocument()
    expect(ui.activate).not.toHaveBeenCalled()
    fireEvent.click(ui.getAllByRole("menuitem")[0])
    expect(ui.menuAction).toHaveBeenCalledTimes(1)
    expect(ui.drop).not.toHaveBeenCalled()
  })

  it("keeps Base UI long press and keyboard menus for a non-draggable item", async () => {
    const ui = setup("channel", false)
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.end()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    fireEvent.keyDown(ui.source, { key: "Escape" })
    await act(async () => { vi.runOnlyPendingTimers() })
    fireEvent.keyDown(ui.source, { key: "ContextMenu" })
    expect(ui.getByRole("menu")).toBeInTheDocument()
    expect(ui.drop).not.toHaveBeenCalled()
  })

  it("cancels an active native drag without a drop and releases the next hold", async () => {
    const ui = setup("server")
    ui.start()
    await ui.hold()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    fireEvent.touchCancel(ui.source, { touches: [], targetTouches: [], changedTouches: [] })
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
    ui.start()
    await ui.hold()
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.end()
  })
})
