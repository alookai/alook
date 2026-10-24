import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { DndProvider } from "react-dnd"
import { TestBackend, type TestBackendImpl } from "react-dnd-test-backend"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { describe, expect, it, vi } from "vitest"
import { CommunityDndProvider, communityDndOptions } from "./community-dnd"
import { RailDndBinding, railInstructionAt, useServerRailDnd, type RailDndController } from "./shell/use-server-rail-dnd"
import { ChannelDndScope, ChannelDropContainer, useChannelDndItem } from "./channels/channel-dnd"
import { ChannelSidebar } from "./channels/channel-sidebar"
import { tid } from "@/lib/community/testids"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { useChannelTree, type ChannelTreeDrop } from "./channels/use-channel-tree"
import type { Category } from "@/lib/community/models/navigation"
import type { RailInstruction, RailState } from "@/lib/community/server-rail-model"

function setup(children: ReactNode) {
  let backend!: TestBackendImpl
  const sources = new Map<HTMLElement, string>()
  const targets = new Map<HTMLElement, string>()
  const view = render(<DndProvider context={{}} backend={(manager, context) => {
    backend = TestBackend(manager, context) as TestBackendImpl
    Object.assign(backend, {
      connectDragSource: (id: string, node: HTMLElement) => { sources.set(node, id); return () => { sources.delete(node) } },
      connectDropTarget: (id: string, node: HTMLElement) => { targets.set(node, id); return () => { targets.delete(node) } },
    })
    return backend
  }}><CommunityDndProvider>{children}</CommunityDndProvider></DndProvider>)
  const node = (id: string) => view.getByTestId(id)
  const start = (id: string) => act(() => backend.simulateBeginDrag([sources.get(node(id))!], {
    clientOffset: { x: 20, y: 20 }, getSourceClientOffset: () => ({ x: 0, y: 0 }),
  }))
  const hover = (id: string, y = 20) => act(() => backend.simulateHover([targets.get(node(id))!], { clientOffset: { x: 20, y } }))
  const drop = () => act(() => { backend.simulateDrop(); backend.simulateEndDrag() })
  const cancel = () => fireEvent.keyDown(window, { key: "Escape" })
  return { ...view, node, start, hover, drop, cancel, backend, targets }
}

const state: RailState = { serverIds: ["a", "b", "c"], folderIds: ["f"], folders: { f: ["c"] }, expanded: [] }
function RailFixture({ onDrop, onCancel = () => {}, onPreview = () => {}, onReady }: { onDrop: (instruction: RailInstruction) => void; onCancel?: () => void; onPreview?: (instruction: RailInstruction | null) => void; onReady?: (cancel: () => void, dnd: RailDndController) => void }) {
  const dnd = useServerRailDnd({ getState: () => state, canStart: () => true, onDragStart: () => {}, onPreview, onDrop, onCancel })
  useLayoutEffect(() => { onReady?.(dnd.cancel, dnd) }, [dnd, onReady])
  return <>{["a", "b"].map((id) => <RailItem key={id} id={id} dnd={dnd} />)}<RailItem id="f" kind="folder" dnd={dnd} /></>
}
function RailItem({ id, kind = "server", dnd }: { id: string; kind?: "server" | "folder"; dnd: ReturnType<typeof useServerRailDnd> }) {
  const ref = useRef<HTMLDivElement>(null)
  return <div ref={ref} data-testid={`rail-${id}`}><RailDndBinding dnd={dnd} entity={{ kind, id }} element={ref} handle={ref} /></div>
}

const channel = (id: string) => ({ id, name: id, unread: false, active: false })
const categories: Category[] = [
  { id: "public", name: "Public", channels: [channel("text"), { ...channel("forum"), type: "forum" }] },
  { id: "empty", name: "Empty", channels: [] },
  { id: "private", name: "Private", private: true, channels: [channel("secret")] },
  { id: "private2", name: "Private 2", private: true, channels: [] },
]
function TreeFixture({ onDrop, canReorder = true, rootBefore = true }: { onDrop: (event: ChannelTreeDrop) => void; canReorder?: boolean; rootBefore?: boolean }) {
  const tree = useChannelTree(categories)
  const settle = (event: ChannelTreeDrop) => { onDrop(event) }
  return <ChannelDndScope tree={tree} onDrop={settle}>
    <output data-testid="tree-order">{JSON.stringify({ cats: tree.catOrder, channels: Object.fromEntries(Object.entries(tree.order).map(([id, rows]) => [id, rows.map((row) => row.id)])) })}</output>
    {tree.catOrder.map((id) => <TreeItem key={id} id={id} kind="category" canReorder={canReorder} />)}
    {Object.values(tree.order).flat().map((row) => <TreeItem key={row.id} id={row.id} kind="channel" canReorder={canReorder} />)}
    <ChannelDropContainer id="empty" />
    <ChannelDropContainer id="public" lastRowId="forum" />
    <ChannelDropContainer id={UNCATEGORIZED_CATEGORY_ID} before={rootBefore} />
  </ChannelDndScope>
}
function TreeItem({ id, kind, canReorder }: { id: string; kind: "category" | "channel"; canReorder: boolean }) {
  const { setNodeRef, setActivatorNodeRef, placement } = useChannelDndItem(id, kind, canReorder)
  return <div ref={setNodeRef} data-testid={id} data-channel-tree-row={kind === "channel" ? id : undefined} data-placement={placement ?? undefined}>{kind === "category" ? <div ref={setActivatorNodeRef} data-testid={`${id}-handle`}>{id}</div> : id}</div>
}

function ActualSidebarFixture({ onReorder }: { onReorder: (ids: string[]) => void }) {
  const tree = useChannelTree([
    { id: UNCATEGORIZED_CATEGORY_ID, name: "", channels: [] },
    ...categories,
    { id: "pending", name: "Pending", pending: true, channels: [] },
  ])
  return <ChannelSidebar tree={tree} serverName="Fixture" activeChannel="" setActiveChannel={() => {}} onReorderCategories={onReorder} />
}

describe("React DnD community scopes", () => {
  it("settles page-background release as cancellation, retaining only a visual return", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList)
    let dnd!: RailDndController
    const onDrop = vi.fn(), onCancel = vi.fn(), onPreview = vi.fn()
    const ui = setup(<RailFixture onDrop={onDrop} onCancel={onCancel} onPreview={onPreview} onReady={(_, value) => { dnd = value }} />)
    ui.node("rail-b").getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect
    ui.start("rail-a"); ui.hover("rail-b", 120)
    act(() => ui.backend.simulateHover([ui.targets.get(document.body)!], { clientOffset: { x: 320, y: 220 } }))
    expect(onPreview).toHaveBeenLastCalledWith(null)
    ui.drop()
    expect(onDrop).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    const returning = dnd.returning.get()!
    expect(returning).toMatchObject({ entity: { kind: "server", id: "a" }, offset: { x: 300, y: 200 } })
    expect(returning.element).toBe(ui.node("rail-a"))
    act(() => dnd.completeReturn(returning))
    expect(dnd.returning.get()).toBeNull()
    ui.start("rail-a"); ui.cancel()
    expect(dnd.returning.get()).not.toBeNull()
    ui.start("rail-a")
    expect(dnd.returning.get()).toBeNull()
    act(() => dnd.cancel())
    expect(dnd.returning.get()).toBeNull()
  })
  it("preserves a valid nested drop instead of replacing it with background cancellation", () => {
    let dnd!: RailDndController
    const onDrop = vi.fn(), onCancel = vi.fn()
    const ui = setup(<RailFixture onDrop={onDrop} onCancel={onCancel} onReady={(_, value) => { dnd = value }} />)
    ui.node("rail-b").getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect
    ui.start("rail-a")
    act(() => ui.backend.simulateHover([ui.targets.get(document.body)!, ui.targets.get(ui.node("rail-b"))!], { clientOffset: { x: 20, y: 38 } }))
    ui.drop()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, operation: "reorder-after" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(dnd.returning.get()).toBeNull()
  })
  it("skips return motion for reduced motion and rejects channel items at the fallback target", () => {
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList)
    try {
      let dnd!: RailDndController
      const onDrop = vi.fn(), onCancel = vi.fn(), treeDrop = vi.fn()
      const ui = setup(<><RailFixture onDrop={onDrop} onCancel={onCancel} onReady={(_, value) => { dnd = value }} /><TreeFixture onDrop={treeDrop} /></>)
      ui.start("rail-a"); ui.cancel()
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(dnd.returning.get()).toBeNull()
      ui.start("text")
      act(() => ui.backend.simulateHover([ui.targets.get(document.body)!], {}))
      ui.drop()
      expect(onDrop).not.toHaveBeenCalled()
      expect(treeDrop).not.toHaveBeenCalled()
    } finally { media.mockRestore() }
  })
  it("uses insertion feedback for nested rows, including a source from outside that folder", () => {
    const nested: RailState = { serverIds: ["a", "b", "c"], folderIds: ["f"], folders: { f: ["b", "c"] }, expanded: ["f"] }
    const source = { kind: "server", id: "a" } as const
    const target = { kind: "server", id: "b" } as const
    expect(railInstructionAt(nested, source, target, 0.4)).toMatchObject({ operation: "reorder-before" })
    expect(railInstructionAt(nested, source, target, 0.6)).toMatchObject({ operation: "reorder-after" })
  })
  it("uses the container end instruction for the final row's after edge", () => {
    const source = { kind: "server", id: "a" } as const
    const nested: RailState = { serverIds: ["a", "b", "c"], folderIds: ["f"], folders: { f: ["b", "c"] }, expanded: ["f"] }
    expect(railInstructionAt(nested, source, { kind: "server", id: "c" }, 0.8)).toEqual({ operation: "append", source, target: { kind: "folder-content", id: "f" } })
    const root: RailState = { serverIds: ["a", "b", "c"], folderIds: [], folders: {}, expanded: [] }
    expect(railInstructionAt(root, source, { kind: "server", id: "c" }, 0.9)).toEqual({ operation: "append", source, target: { kind: "root", id: "root" } })
    expect(railInstructionAt(root, source, { kind: "server", id: "b" }, 0.9)).toEqual({ operation: "reorder-after", source, target: { kind: "server", id: "b" } })
    expect(railInstructionAt(root, { kind: "server", id: "c" }, { kind: "server", id: "c" }, 0.9)).toBeNull()
  })
  it("updates center/combine and edge/insertion feedback while staying over the same target", () => {
    const onPreview = vi.fn()
    const ui = setup(<RailFixture onDrop={vi.fn()} onPreview={onPreview} />)
    ui.node("rail-b").getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect
    ui.start("rail-a"); ui.hover("rail-b", 120)
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "combine" }))
    ui.hover("rail-b", 138)
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "reorder-after" }))
    ui.hover("rail-b", 102)
    expect(onPreview).toHaveBeenLastCalledWith(null)
    ui.hover("rail-b", 120)
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "combine" }))
    ui.cancel()
  })
  it("ends a route-cancelled backend drag without a drop and allows the next drag", () => {
    let cancel!: () => void
    const onDrop = vi.fn(), onCancel = vi.fn(), onPreview = vi.fn()
    const ui = setup(<RailFixture onDrop={onDrop} onCancel={onCancel} onPreview={onPreview} onReady={(next) => { cancel = next }} />)
    ui.node("rail-b").getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect
    ui.start("rail-a"); ui.hover("rail-b", 38)
    act(() => cancel())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(onDrop).not.toHaveBeenCalled()
    ui.start("rail-a"); ui.hover("rail-b", 38); ui.drop()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, operation: "reorder-after" })
  })
  it("accepts the whole folder header without expansion or writes before drop", () => {
    vi.useFakeTimers()
    try {
      const onDrop = vi.fn(), onPreview = vi.fn()
      const ui = setup(<RailFixture onDrop={onDrop} onPreview={onPreview} />)
      ui.node("rail-f").getBoundingClientRect = () => ({ top: 100, height: 40 }) as DOMRect
      ui.start("rail-a"); ui.hover("rail-f", 102)
      expect(onPreview).toHaveBeenLastCalledWith({ source: { kind: "server", id: "a" }, target: { kind: "folder", id: "f" }, operation: "combine" })
      act(() => vi.advanceTimersByTime(500))
      expect(state.expanded).toEqual([])
      ui.hover("rail-f", 138)
      expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "combine" }))
      act(() => ui.backend.simulateHover([], {}))
      expect(onPreview).toHaveBeenLastCalledWith(null)
      ui.hover("rail-f", 120); ui.cancel()
      act(() => vi.advanceTimersByTime(500))
      expect(state.expanded).toEqual([])
      expect(onDrop).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it("rejects an eleventh-folder center drop without changing it to reorder", () => {
    const folderIds = Array.from({ length: 10 }, (_, index) => `f${index}`)
    const capped: RailState = {
      serverIds: ["a", "b", ...folderIds.map((id) => `s${id}`)],
      folderIds, folders: Object.fromEntries(folderIds.map((id) => [id, [`s${id}`]])), expanded: [],
    }
    const source = { kind: "server", id: "a" } as const
    const target = { kind: "server", id: "b" } as const
    expect(railInstructionAt(capped, source, target, 0.5)).toBeNull()
    expect(railInstructionAt(capped, source, target, 0.9)).toMatchObject({ operation: "reorder-after" })
  })
  it("uses official touch activation settings and keeps a native HTML5 preview", () => {
    expect(communityDndOptions.backends.map((entry) => entry.id)).toEqual(["html5", "touch"])
    expect(communityDndOptions.backends[1].options).toMatchObject({ delayTouchStart: 650, touchSlop: 8 })
  })
  it("commits one rail instruction on drop; Escape commits nothing", () => {
    const onDrop = vi.fn(), onCancel = vi.fn()
    const ui = setup(<RailFixture onDrop={onDrop} onCancel={onCancel} />)
    ui.node("rail-b").getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect
    ui.start("rail-a"); ui.hover("rail-b", 38)
    expect(onDrop).not.toHaveBeenCalled()
    ui.drop()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, operation: "reorder-after" })
    ui.start("rail-a"); ui.hover("rail-b", 20); ui.cancel()
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it("keeps hover structural state unchanged and settles text/forum order on drop", () => {
    const onDrop = vi.fn()
    const ui = setup(<TreeFixture onDrop={onDrop} />)
    const before = ui.node("tree-order").textContent
    ui.start("text"); ui.hover("forum")
    expect(ui.node("tree-order").textContent).toBe(before)
    ui.drop()
    expect(ui.node("tree-order").textContent).toBe(before)
    expect(onDrop).toHaveBeenCalledWith({ active: { id: "text", kind: "channel" }, over: { id: "public", kind: "category" }, placement: "append" })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
  it("accepts an empty category, rejects privacy changes, and allows private/private", () => {
    const onDrop = vi.fn()
    const ui = setup(<TreeFixture onDrop={onDrop} />)
    ui.start("text"); ui.hover("empty-handle"); ui.drop()
    expect(onDrop).toHaveBeenLastCalledWith({ active: { id: "text", kind: "channel" }, over: { id: "empty", kind: "category" }, placement: "append" })
    ui.start("forum"); ui.hover("private"); ui.drop()
    expect(onDrop).toHaveBeenCalledTimes(1)
    ui.start("secret"); ui.hover("private2-handle"); ui.drop()
    expect(onDrop).toHaveBeenLastCalledWith({ active: { id: "secret", kind: "channel" }, over: { id: "private2", kind: "category" }, placement: "append" })
    expect(onDrop).toHaveBeenCalledTimes(2)
  })
  it("shows valid header feedback and updates row edges without stale hover snapshots", () => {
    const ui = setup(<TreeFixture onDrop={vi.fn()} />)
    ui.node("forum").getBoundingClientRect = () => ({ top: 100, bottom: 132, left: 0, right: 100, height: 32, width: 100 }) as DOMRect
    ui.start("text"); ui.hover("empty-handle")
    expect(ui.node("empty")).toHaveAttribute("data-placement", "append")
    ui.hover("private-handle")
    expect(ui.node("empty")).not.toHaveAttribute("data-placement")
    expect(ui.node("private")).not.toHaveAttribute("data-placement")
    ui.hover("forum", 130)
    expect(ui.node("forum")).toHaveAttribute("data-placement", "append")
    expect(ui.container.querySelector('[data-channel-drop-end="public"]')).toHaveAttribute("data-drop-visible", "true")
    ui.hover("forum", 102)
    expect(ui.node("forum")).not.toHaveAttribute("data-placement")
    ui.cancel()
    expect(ui.node("empty")).not.toHaveAttribute("data-placement")
  })
  it("keeps a nearby end target stable while its landing area opens and closes", () => {
    const onDrop = vi.fn()
    const ui = setup(<TreeFixture onDrop={onDrop} />)
    const end = ui.container.querySelector<HTMLElement>('[data-channel-drop-end="empty"]')!
    const anchor = end.parentElement!
    anchor.getBoundingClientRect = () => ({ top: 100, bottom: 100, left: 0, right: 100, height: 0, width: 100 }) as DOMRect
    ui.start("text")
    act(() => ui.backend.simulateHover([], { clientOffset: { x: 20, y: 86 } }))
    expect(end).not.toHaveAttribute("data-drop-visible")
    act(() => ui.backend.simulateHover([ui.targets.get(end)!], { clientOffset: { x: 20, y: 108 } }))
    expect(end).toHaveAttribute("data-drop-visible", "true")
    expect(end).toHaveClass("absolute", "h-4")
    expect(anchor).toHaveClass("h-0")
    expect(anchor.getBoundingClientRect().top).toBe(100)
    expect(onDrop).not.toHaveBeenCalled()
    ui.drop()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ active: { id: "text", kind: "channel" }, over: { id: "empty", kind: "category" }, placement: "append" })
    expect(end).not.toHaveAttribute("data-drop-visible")
    ui.start("text")
    act(() => ui.backend.simulateHover([], { clientOffset: { x: 20, y: 149 } }))
    expect(end).not.toHaveAttribute("data-drop-visible")
    ui.cancel()
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
  it("uses existing space before an empty root without capturing the first header", () => {
    const onDrop = vi.fn()
    const ui = setup(<TreeFixture onDrop={onDrop} />)
    const end = ui.container.querySelector<HTMLElement>(`[data-channel-drop-end="${UNCATEGORIZED_CATEGORY_ID}"]`)!
    end.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 100, left: 0, right: 100, height: 0, width: 100 }) as DOMRect
    ui.start("text")
    act(() => ui.backend.simulateHover([ui.targets.get(end)!], { clientOffset: { x: 20, y: 92 } }))
    expect(end).toHaveAttribute("data-drop-visible", "true")
    expect(end).toHaveClass("absolute", "bottom-0", "h-4")
    act(() => ui.backend.simulateHover([], { clientOffset: { x: 20, y: 100 } }))
    expect(end).not.toHaveAttribute("data-drop-visible")
    act(() => ui.backend.simulateHover([ui.targets.get(end)!], { clientOffset: { x: 20, y: 92 } }))
    ui.drop()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ active: { id: "text", kind: "channel" }, over: { id: UNCATEGORIZED_CATEGORY_ID, kind: "category" }, placement: "append" })
  })
  it("uses the current root end geometry after a canonical update while idle", () => {
    const onDrop = vi.fn()
    function RootFixture() {
      const [before, setBefore] = useState(true)
      return <><button data-testid="root-filled" onClick={() => setBefore(false)}>Fill root</button><TreeFixture onDrop={onDrop} rootBefore={before} /></>
    }
    const ui = setup(<RootFixture />)
    const end = ui.container.querySelector<HTMLElement>(`[data-channel-drop-end="${UNCATEGORIZED_CATEGORY_ID}"]`)!
    end.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 100, left: 0, right: 100, height: 0, width: 100 }) as DOMRect
    fireEvent.click(ui.node("root-filled"))
    expect(ui.container.querySelector(`[data-channel-drop-end="${UNCATEGORIZED_CATEGORY_ID}"]`)).toBe(end)
    ui.start("text")
    act(() => ui.backend.simulateHover([ui.targets.get(end)!], { clientOffset: { x: 20, y: 108 } }))
    expect(end).toHaveClass("top-0", "h-4")
    expect(end).toHaveAttribute("data-drop-visible", "true")
    ui.drop()
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
  it("moves category blocks and cancels a channel without changing its owner", () => {
    const onDrop = vi.fn()
    const ui = setup(<TreeFixture onDrop={onDrop} />)
    ui.start("public-handle"); ui.hover("empty"); ui.drop()
    expect(onDrop).toHaveBeenCalledWith({ active: { id: "public", kind: "category" }, over: { id: "empty", kind: "category" }, placement: "after" })
    const before = ui.node("tree-order").textContent
    ui.start("text"); ui.hover("empty"); ui.cancel()
    expect(ui.node("tree-order").textContent).toBe(before)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
  it("persists only real non-pending categories from the actual sidebar", () => {
    const onReorder = vi.fn()
    const ui = setup(<ActualSidebarFixture onReorder={onReorder} />)
    ui.start(tid.categoryHeader("public"))
    const target = ui.node(tid.categoryHeader("empty")).closest<HTMLElement>("[data-channel-category]")!
    act(() => ui.backend.simulateHover([ui.targets.get(target)!], { clientOffset: { x: 20, y: 20 } }))
    ui.drop()
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(["empty", "public", "private", "private2"])
  })
  it("opens the held item menu without stopping native touch input needed by dragging", async () => {
    vi.useFakeTimers()
    const touchStarted = vi.fn()
    document.addEventListener("touchstart", touchStarted)
    try {
      const ui = setup(<ActualSidebarFixture onReorder={() => {}} />)
      const node = ui.node(tid.categoryHeader("public"))
      fireEvent.touchStart(node, { touches: [{ identifier: 1, clientX: 20, clientY: 20, target: node }] })
      await act(async () => { vi.advanceTimersByTime(700) })
      expect(touchStarted).toHaveBeenCalledTimes(1)
      expect(ui.queryByRole("menu")).toBeInTheDocument()
      fireEvent.touchEnd(node, { touches: [] })
    } finally {
      document.removeEventListener("touchstart", touchStarted)
      vi.useRealTimers()
    }
  })
  it("does not let rail and channel items drop into the other scope", () => {
    const railDrop = vi.fn(), treeDrop = vi.fn()
    const ui = setup(<><RailFixture onDrop={railDrop} /><TreeFixture onDrop={treeDrop} /></>)
    ui.start("rail-a"); ui.hover("empty"); ui.drop()
    ui.start("text"); ui.hover("rail-b"); ui.drop()
    expect(railDrop).not.toHaveBeenCalled()
    expect(treeDrop).not.toHaveBeenCalled()
  })
})
