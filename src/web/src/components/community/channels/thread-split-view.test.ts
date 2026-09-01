import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import {
  THREAD_SPLIT_PANEL_MAX_WIDTH,
  THREAD_SPLIT_PANEL_MIN_WIDTH,
  ThreadSplitView,
} from "./thread-split-view"

const mocks = vi.hoisted(() => ({
  onLayoutChanged: vi.fn(),
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: { parent: 56, thread: 44 },
    onLayoutChanged: mocks.onLayoutChanged,
  }),
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: (props: Record<string, unknown>) => createElement("panel-group", props),
  ResizablePanel: (props: Record<string, unknown>) => createElement("panel", props),
  ResizableHandle: (props: Record<string, unknown>) => createElement("panel-handle", props),
}))

describe("ThreadSplitView", () => {
  it("uses the shared persistent resize contract in split mode", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ThreadSplitView, {
        containerRef: vi.fn(),
        split: true,
        parent: createElement("parent-content"),
        thread: createElement("thread-content"),
      }))
    })

    expect(renderer.root.findByType("panel-group").props).toMatchObject({
      id: "community-thread-split-layout",
      orientation: "horizontal",
      defaultLayout: { parent: 56, thread: 44 },
      onLayoutChanged: mocks.onLayoutChanged,
    })
    const [parent, thread] = renderer.root.findAllByType("panel")
    expect(parent?.props).toMatchObject({ id: "parent", defaultSize: "56%", minSize: 320 })
    expect(thread?.props).toMatchObject({
      id: "thread",
      defaultSize: "44%",
      minSize: THREAD_SPLIT_PANEL_MIN_WIDTH,
      maxSize: THREAD_SPLIT_PANEL_MAX_WIDTH,
    })
    expect(renderer.root.findByType("panel-handle").props["aria-label"])
      .toBe("Resize thread panel")
  })

  it("keeps full mode single-pane without resize affordances", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ThreadSplitView, {
        containerRef: vi.fn(),
        split: false,
        parent: createElement("parent-content"),
        thread: createElement("thread-content"),
      }))
    })

    expect(renderer.root.findAllByType("panel-group")).toHaveLength(0)
    expect(renderer.root.findAllByType("panel-handle")).toHaveLength(0)
    expect(renderer.root.findAllByType("parent-content")).toHaveLength(0)
    expect(renderer.root.findByProps({ "aria-label": "Thread" }).props.className)
      .toContain("flex-1")
  })
})
