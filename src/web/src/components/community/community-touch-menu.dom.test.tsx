import { useLayoutEffect } from "react"
import { useDragDropManager } from "react-dnd"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, mockElementGeometry, render } from "@/test/react-dom-harness"
import { CommunityDndProvider, communityTouchHoldDelay } from "./community-dnd"
import { SortableServer } from "./shell/sortable-server"
import { useServerRailDnd } from "./shell/use-server-rail-dnd"
import { ChannelDndScope, ChannelDropContainer } from "./channels/channel-dnd"
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

function Tree({ kind, drop, activate, menuAction, enabled, withHref }: { kind: Exclude<Kind, "server">; drop: (event: ChannelTreeDrop) => void; activate: () => void; menuAction: () => void; enabled: boolean; withHref: boolean }) {
  const tree = useChannelTree([{ id: "category-a", name: "a", channels: [{ id: "channel-a", name: "a", unread: false, active: false }, { id: "channel-b", name: "b", unread: false, active: false }] }, { id: "category-b", name: "b", channels: [] }])
  return <ChannelDndScope tree={tree} onDrop={drop} enabled={enabled}>{[`${kind}-a`, `${kind}-b`].map(id => kind === "channel"
    ? <SortableChannel key={id} ch={{ id, name: id, unread: false, active: false }} href={withHref ? `/c/channels/server/${id}` : undefined} active={false} onClick={activate} onEdit={menuAction} canReorder={enabled} />
    : <SortableCategory key={id} id={id} name={id} open onToggle={activate} onAddChannel={menuAction} onSettings={menuAction} canReorder={enabled} hasChannels>{null}</SortableCategory>)}<ChannelDropContainer id="category-b" /></ChannelDndScope>
}

function EmptyChannelScope({ enabled }: { enabled: boolean }) {
  const tree = useChannelTree([])
  return <ChannelDndScope tree={tree} onDrop={() => {}} enabled={enabled}>{null}</ChannelDndScope>
}

function setup(kind: Kind, enabled = true, includeOtherScope = false, options: { target?: "row" | "text" | "settings" | "create"; channelHref?: boolean } = {}) {
  vi.useFakeTimers()
  const drop = vi.fn(), activate = vi.fn(), menuAction = vi.fn()
  let manager!: DragDropManager
  const content = (enabled: boolean, otherEnabled = true) => <CommunityDndProvider><Probe ready={value => { manager = value }} />{kind === "server" ? <Rail drop={drop} activate={activate} menuAction={menuAction} enabled={enabled} /> : <Tree kind={kind} drop={drop} activate={activate} menuAction={menuAction} enabled={enabled} withHref={options.channelHref ?? false} />}{includeOtherScope && <EmptyChannelScope enabled={otherEnabled} />}</CommunityDndProvider>
  const view = render(content(enabled))
  views.push(view)
  const testid = kind === "server" ? tid.serverIcon : kind === "channel" ? tid.channelRow : tid.categoryHeader
  const source = view.getByTestId(testid(kind === "server" ? "a" : `${kind}-a`)), target = view.getByTestId(testid(kind === "server" ? "b" : `${kind}-b`))
  const startNode = options.target === "text"
    ? Array.from(source.querySelectorAll("span")).find(node => node.textContent === (kind === "server" ? "a" : `${kind}-a`))
    : options.target === "settings" || options.target === "create"
      ? source.querySelector(`button[aria-label="${options.target === "settings" ? "Category settings for" : "Create channel in"} ${kind}-a"] svg`)
      : source
  if (!startNode) throw new Error("Missing touch start target")
  mockElementGeometry(source, { top: 0, left: 0, width: 100, height: 40 })
  mockElementGeometry(target, { top: 100, left: 0, width: 100, height: 40 })
  if (kind === "category") {
    mockElementGeometry(source.parentElement!, { top: 0, left: 0, width: 100, height: 40 })
    mockElementGeometry(target.parentElement!, { top: 100, left: 0, width: 100, height: 40 })
  }
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (_x: number, y: number) => y >= 90 ? target : startNode })
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (_x: number, y: number) => [y >= 90 ? target : startNode] })
  const touch = (y: number) => ({ identifier: 1, clientX: 20, clientY: y, target: startNode })
  const start = (pointer = true) => {
    if (pointer) fireEvent.pointerDown(startNode, { pointerType: "touch", button: 0 })
    fireEvent.touchStart(startNode, { touches: [touch(20)], targetTouches: [touch(20)], changedTouches: [touch(20)] })
  }
  const warm = () => {
    const warmTouch = { identifier: 2, clientX: 20, clientY: 20, target: source }
    fireEvent.pointerDown(source, { pointerType: "touch", button: 0 })
    fireEvent.touchStart(source, { touches: [warmTouch], targetTouches: [warmTouch], changedTouches: [warmTouch] })
    fireEvent.touchCancel(source, { touches: [], targetTouches: [], changedTouches: [warmTouch] })
  }
  const move = (y: number) => fireEvent.touchMove(startNode, { touches: [touch(y)], targetTouches: [touch(y)], changedTouches: [touch(y)] })
  const end = (y = 120) => fireEvent.touchEnd(startNode, { touches: [], targetTouches: [], changedTouches: [touch(y)] })
  const hold = async () => { await act(async () => { vi.advanceTimersByTime(communityTouchHoldDelay + 20) }) }
  return { ...view, manager, drop, activate, menuAction, source, startNode, start, warm, move, end, hold, setEnabled: (next: boolean) => view.rerender(content(next)), setOtherEnabled: (next: boolean) => view.rerender(content(enabled, next)) }
}

describe("native community touch menu and drag handoff", () => {
  it.each<Kind>(["server", "channel", "category"])("opens the %s menu at 500ms and starts same-touch dragging without another hold", async kind => {
    const ui = setup(kind, true, false, { target: "text", channelHref: true })
    ui.start()
    await act(async () => { vi.advanceTimersByTime(499) })
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.move(130)
    ui.end()
    expect(ui.drop).toHaveBeenCalledTimes(1)
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
  })

  it.each(["settings", "create"] as const)("keeps a category %s button hold out of the parent menu and drag", async target => {
    const ui = setup("category", true, false, { target })
    expect(ui.startNode.closest("button")).not.toBeNull()
    ui.start()
    await ui.hold()
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    ui.move(130)
    ui.end()
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
  })

  it.each(["settings", "create"] as const)("activates only the category %s button on a short touch", async target => {
    const ui = setup("category", true, false, { target })
    ui.start()
    ui.end()
    fireEvent.click(ui.startNode)
    await ui.hold()
    expect(ui.menuAction).toHaveBeenCalledTimes(1)
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
  })

  it.each(["settings", "create"] as const)("cancels a native mouse drag from the category %s button", target => {
    const ui = setup("category", true, false, { target })
    expect(fireEvent.dragStart(ui.startNode, { dataTransfer: {} })).toBe(false)
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
  })

  it.each((["settings", "create"] as const).flatMap(target => [true, false].map(pointer => ({ target, pointer }))))("rejects the category $target press in active TouchBackend with pointer events=$pointer", async ({ target, pointer }) => {
    const ui = setup("category", true, false, { target })
    ui.warm()
    ui.start(pointer)
    await ui.hold()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(document.querySelector("[data-channel-floating-preview]")).toBeNull()
    ui.move(130); ui.end()
    expect(ui.drop).not.toHaveBeenCalled()
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    expect(ui.menuAction).not.toHaveBeenCalled()
    ui.warm()
    const touch = (y: number) => ({ identifier: 3, clientX: 20, clientY: y, target: ui.source })
    fireEvent.pointerDown(ui.source, { pointerType: "touch", button: 0 })
    fireEvent.touchStart(ui.source, { touches: [touch(20)], targetTouches: [touch(20)], changedTouches: [touch(20)] })
    await ui.hold()
    fireEvent.touchMove(ui.source, { touches: [touch(55)], targetTouches: [touch(55)], changedTouches: [touch(55)] })
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    fireEvent.touchMove(ui.source, { touches: [touch(130)], targetTouches: [touch(130)], changedTouches: [touch(130)] })
    fireEvent.touchEnd(ui.source, { touches: [], targetTouches: [], changedTouches: [touch(130)] })
    expect(ui.drop).toHaveBeenCalledTimes(1)
  })

  it.each(["settings", "create"] as const)("rejects a parent-target HTML5 dragstart initiated on the category %s button", target => {
    const ui = setup("category", true, false, { target })
    fireEvent.pointerDown(ui.startNode, { pointerType: "mouse", button: 0 })
    fireEvent.mouseDown(ui.startNode, { button: 0 })
    expect(fireEvent.dragStart(ui.source, { clientX: 20, clientY: 20, dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), types: [], files: [] } })).toBe(false)
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).not.toHaveBeenCalled()
    fireEvent.pointerDown(ui.source, { pointerType: "mouse", button: 0 })
    fireEvent.mouseDown(ui.source, { button: 0 })
    fireEvent.dragStart(ui.source, { clientX: 20, clientY: 20, dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), types: [], files: [] } })
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).not.toHaveBeenCalled()
  })

  it("opens an unselected end hit area on the first native move and saves only after an accepted hover", async () => {
    const ui = setup("channel", true, false, { target: "text", channelHref: true })
    const end = ui.container.querySelector<HTMLElement>('[data-channel-drop-end="category-b"]')!
    mockElementGeometry(end.parentElement!, { top: 100, left: 0, width: 100, height: 0 })
    const hit = (y: number) => y < 90 ? ui.startNode : end.classList.contains("h-4") ? end : document.body
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (_x: number, y: number) => hit(y) })
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (_x: number, y: number) => [hit(y)] })
    ui.start(); await ui.hold(); ui.move(108)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    expect(ui.manager.getMonitor().getTargetIds()).toEqual([])
    expect(end).toHaveClass("h-4")
    expect(end).not.toHaveAttribute("data-drop-visible")
    expect(end).not.toHaveClass("border-dashed")
    ui.end(108)
    expect(ui.drop).not.toHaveBeenCalled()
    ui.start(); await ui.hold(); ui.move(108); ui.move(109)
    expect(end).toHaveAttribute("data-drop-visible", "true")
    ui.end(109)
    expect(ui.drop).toHaveBeenCalledExactlyOnceWith({ active: { id: "channel-a", kind: "channel" }, over: { id: "category-b", kind: "category" }, placement: "append" })
  })

  it.each((["channel", "category"] as const).flatMap(kind => (["row", "text"] as const).map(target => ({ kind, target }))))("starts a $kind drag at its $target with production link rendering", async ({ kind, target }) => {
    const ui = setup(kind, true, false, { target, channelHref: true })
    expect(ui.source.tagName).toBe(kind === "channel" ? "A" : "DIV")
    expect(ui.source.contains(ui.startNode)).toBe(true)
    if (target === "text") expect(ui.startNode).not.toBe(ui.source)
    ui.start()
    await ui.hold()
    expect(ui.startNode.isConnected).toBe(true)
    expect(ui.getByRole("menu")).toBeInTheDocument()
    ui.move(55)
    expect(ui.manager.getMonitor().isDragging()).toBe(true)
    expect(ui.queryByRole("menu")).not.toBeInTheDocument()
    ui.move(130)
    ui.end()
    expect(ui.manager.getMonitor().isDragging()).toBe(false)
    expect(ui.drop).toHaveBeenCalledTimes(1)
    expect(ui.activate).not.toHaveBeenCalled()
    expect(ui.menuAction).not.toHaveBeenCalled()
  })

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
