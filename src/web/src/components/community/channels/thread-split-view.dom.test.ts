import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import {
  THREAD_SPLIT_PANEL_MAX_WIDTH,
  THREAD_SPLIT_PANEL_MIN_WIDTH,
  ThreadSplitView,
} from "./thread-split-view"

const mocks = vi.hoisted(() => ({
  onLayoutChanged: vi.fn(),
  useDefaultLayout: vi.fn(),
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: (options: unknown) => { mocks.useDefaultLayout(options); return ({
    defaultLayout: { parent: 56, thread: 44 },
    onLayoutChanged: mocks.onLayoutChanged,
  }) },
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    id,
    orientation,
    defaultLayout,
    onLayoutChanged,
  }: PropsWithChildren<Record<string, unknown>>) => createElement("div", {
    "data-testid": "panel-group",
    "data-id": id,
    "data-orientation": orientation,
    "data-default-layout": JSON.stringify(defaultLayout),
    "data-persists-layout": String(typeof onLayoutChanged === "function"),
  }, children),
  ResizablePanel: ({
    children,
    id,
    defaultSize,
    minSize,
    maxSize,
  }: PropsWithChildren<Record<string, unknown>>) => createElement("div", {
    "data-testid": `panel-${id}`,
    "data-default-size": defaultSize,
    "data-min-size": minSize,
    "data-max-size": maxSize,
  }, children),
  ResizableHandle: (props: Record<string, unknown>) => createElement("div", props),
}))

describe("ThreadSplitView", () => {
  it("uses the shared persistent resize contract in split mode", () => {
    render(createElement(ThreadSplitView, {
      split: true,
      parent: createElement("span", null, "Parent content"),
      thread: createElement("span", null, "Thread content"),
    }))

    const group = screen.getByTestId("panel-group")
    expect(group).toHaveAttribute("data-id", "community-thread-split-layout")
    expect(group).toHaveAttribute("data-orientation", "horizontal")
    expect(group).toHaveAttribute("data-default-layout", JSON.stringify({
      parent: 56,
      thread: 44,
    }))
    expect(group).toHaveAttribute("data-persists-layout", "true")
    expect(screen.getByTestId("panel-parent")).toHaveAttribute("data-default-size", "56%")
    expect(screen.getByTestId("panel-parent")).toHaveAttribute("data-min-size", "320")
    expect(screen.getByTestId("panel-thread")).toHaveAttribute("data-default-size", "44%")
    expect(screen.getByTestId("panel-thread"))
      .toHaveAttribute("data-min-size", String(THREAD_SPLIT_PANEL_MIN_WIDTH))
    expect(screen.getByTestId("panel-thread"))
      .toHaveAttribute("data-max-size", String(THREAD_SPLIT_PANEL_MAX_WIDTH))
    expect(screen.getByLabelText("Resize thread panel")).toBeVisible()
    expect(mocks.useDefaultLayout).toHaveBeenLastCalledWith({
      id: "community-thread-split-layout",
      onlySaveAfterUserInteractions: true,
      storage: expect.any(Object),
    })
  })

  it("keeps full mode single-pane without resize affordances", () => {
    render(createElement(ThreadSplitView, {
      split: false,
      parent: createElement("span", null, "Parent content"),
      thread: createElement("span", null, "Thread content"),
    }))

    expect(screen.queryByTestId("panel-group")).not.toBeInTheDocument()
    expect(screen.queryByText("Parent content")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Thread")).toHaveClass("flex-1")
    expect(screen.getByText("Thread content")).toBeVisible()
  })

  it("keeps both panels and their group when skeletons become content", () => {
    const renderer = render(createElement(ThreadSplitView, {
      split: true,
      parent: createElement("span", null, "Parent skeleton"),
      thread: createElement("span", null, "Thread skeleton"),
    }))
    const group = screen.getByTestId("panel-group")
    const parent = screen.getByTestId("panel-parent")
    const thread = screen.getByTestId("panel-thread")
    renderer.rerender(createElement(ThreadSplitView, {
      split: true,
      parent: createElement("span", null, "Parent content"),
      thread: createElement("span", null, "Thread content"),
    }))
    expect(screen.getByTestId("panel-group")).toBe(group)
    expect(screen.getByTestId("panel-parent")).toBe(parent)
    expect(screen.getByTestId("panel-thread")).toBe(thread)
    expect(screen.queryByText("Thread skeleton")).not.toBeInTheDocument()
    expect(mocks.onLayoutChanged).not.toHaveBeenCalled()
  })
})
