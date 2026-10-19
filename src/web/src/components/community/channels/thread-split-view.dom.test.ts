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

vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: () => null }))

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
    disabled,
    "aria-hidden": ariaHidden,
    inert,
  }: PropsWithChildren<Record<string, unknown>>) => createElement("div", {
    "data-testid": "panel-group",
    "data-id": id,
    "data-orientation": orientation,
    "data-default-layout": JSON.stringify(defaultLayout),
    "data-persists-layout": String(typeof onLayoutChanged === "function"),
    "data-disabled": String(disabled),
    "data-hidden": String(ariaHidden),
    "data-inert": String(inert),
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
  it("reserves the native parent, target and handle while layout measurement is pending", () => {
    const props = {
      split: false, layoutPending: true,
      parent: createElement("input", { "data-testid": "pending-parent-draft", defaultValue: "Parent draft" }),
      thread: createElement("input", { "data-testid": "pending-thread-draft", defaultValue: "Thread draft" }),
    }
    const renderer = render(createElement(ThreadSplitView, props))
    const group = screen.getByTestId("panel-group")
    const parent = screen.getByTestId("pending-parent-draft")
    const thread = screen.getByTestId("pending-thread-draft")
    const handle = screen.getByLabelText("Resize thread panel")
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout-pending", "true")
    expect(group).toHaveAttribute("data-disabled", "true")
    expect(group).toHaveAttribute("data-persists-layout", "false")
    expect(parent.closest("section")).toHaveAttribute("inert")
    renderer.rerender(createElement(ThreadSplitView, { ...props, split: true, layoutPending: false }))
    expect(screen.getByTestId("panel-group")).toBe(group)
    expect(screen.getByTestId("pending-parent-draft")).toBe(parent)
    expect(screen.getByTestId("pending-thread-draft")).toBe(thread)
    expect(screen.getByLabelText("Resize thread panel")).toBe(handle)
    expect(parent.closest("section")).not.toHaveAttribute("inert")
    expect(screen.getByTestId("community-thread-split")).not.toHaveAttribute("data-layout-pending")
    renderer.unmount()
  })

  it("settles pending measurement to a single pane without replacing the target", () => {
    const props = {
      split: false, parent: createElement("span", null, "Parent content"),
      thread: createElement("input", { "data-testid": "pending-target", defaultValue: "Unsent target" }),
    }
    const renderer = render(createElement(ThreadSplitView, { ...props, layoutPending: true }))
    const group = screen.getByTestId("panel-group")
    const target = screen.getByTestId("pending-target")
    renderer.rerender(createElement(ThreadSplitView, props))
    expect(screen.getByTestId("panel-group")).toBe(group)
    expect(screen.getByTestId("pending-target")).toBe(target)
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "full")
    expect(screen.queryByText("Parent content")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Resize thread panel")).not.toBeInTheDocument()
    expect(group).toHaveAttribute("data-persists-layout", "false")
    renderer.unmount()
  })

  it("keeps the actual parent mounted but inert beneath a mobile thread", () => {
    const parent = createElement("input", { "data-testid": "back-parent-draft", defaultValue: "keep me" })
    const renderer = render(createElement(ThreadSplitView, {
      split: false, mobileBack: true, parent, thread: createElement("span", null, "Child"),
    }))
    const draft = screen.getByTestId("back-parent-draft")
    expect(draft.closest("section")).toHaveAttribute("inert")
    expect(draft.closest("section")).toHaveAttribute("aria-hidden", "true")
    expect(screen.getByTestId("panel-group")).toHaveAttribute("data-persists-layout", "false")
    renderer.rerender(createElement(ThreadSplitView, {
      split: false, preserveParent: true, parent, thread: createElement("span", null, "Child"),
    }))
    expect(screen.getByTestId("back-parent-draft")).toBe(draft)
    expect(draft.closest("section")).toHaveAttribute("inert")
    expect(draft.closest("section")).toHaveAttribute("aria-hidden", "true")
    renderer.rerender(createElement(ThreadSplitView, {
      split: true, parent, thread: createElement("span", null, "Child"),
    }))
    expect(screen.getByTestId("back-parent-draft")).toBe(draft)
    expect(draft.closest("section")).not.toHaveAttribute("inert")
  })

  it("keeps parent input, scroll node and group when the keyed right child changes", () => {
    const parent = createElement("div", { "data-testid": "parent-scroll" },
      createElement("input", { "data-testid": "parent-draft", defaultValue: "" }))
    const renderer = render(createElement(ThreadSplitView, {
      split: true, parent, thread: createElement("span", { key: "A" }, "Child A"),
    }))
    const group = screen.getByTestId("panel-group")
    const scroll = screen.getByTestId("parent-scroll")
    const draft = screen.getByTestId("parent-draft") as HTMLInputElement
    scroll.scrollTop = 72
    draft.value = "Unsent parent"
    renderer.rerender(createElement(ThreadSplitView, {
      split: true, parent, thread: createElement("span", { key: "B" }, "Child B pending"),
    }))
    expect(screen.getByTestId("panel-group")).toBe(group)
    expect(screen.getByTestId("parent-scroll")).toBe(scroll)
    expect(scroll.scrollTop).toBe(72)
    expect(screen.getByTestId("parent-draft")).toBe(draft)
    expect(draft.value).toBe("Unsent parent")
    expect(screen.queryByText("Child A")).not.toBeInTheDocument()
    expect(screen.getByText("Child B pending")).toBeVisible()
  })
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

    expect(screen.getByTestId("panel-group")).toHaveAttribute("data-disabled", "true")
    expect(screen.getByTestId("panel-group")).toHaveAttribute("data-persists-layout", "false")
    expect(screen.queryByText("Parent content")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Resize thread panel")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Thread")).toHaveClass("flex-1")
    expect(screen.getByText("Thread content")).toBeVisible()
  })

  it("keeps the target input, section, panel and group across type resolution and layout changes", () => {
    const thread = createElement("input", { "data-testid": "target-input" })
    const renderer = render(createElement(ThreadSplitView, {
      split: false, parent: null, thread, conversationSubtype: "unknown",
    }))
    const group = screen.getByTestId("panel-group")
    const panel = screen.getByTestId("panel-thread")
    const section = screen.getByLabelText("Conversation")
    const input = screen.getByTestId("target-input") as HTMLInputElement
    input.value = "Target draft"
    for (const split of [false, true, false, true]) {
      renderer.rerender(createElement(ThreadSplitView, {
        split, parent: createElement("span", null, "Parent content"), thread, conversationSubtype: "thread",
      }))
      expect(screen.getByTestId("panel-group")).toBe(group)
      expect(screen.getByTestId("panel-thread")).toBe(panel)
      expect(screen.getByTestId("community-thread-split-panel")).toBe(section)
      expect(screen.getByTestId("target-input")).toBe(input)
      expect(input.value).toBe("Target draft")
      expect(panel).toHaveAttribute("data-min-size", String(THREAD_SPLIT_PANEL_MIN_WIDTH))
      expect(panel).toHaveAttribute("data-max-size", String(THREAD_SPLIT_PANEL_MAX_WIDTH))
    }
    renderer.unmount()
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

  it("keeps the group and target slot inert behind parent resolution, then shows their own content", () => {
    const props = {
      split: true, parent: createElement("span", null, "Parent loading"),
      thread: createElement("input", { "data-testid": "target-input" }),
    }
    const renderer = render(createElement(ThreadSplitView, { ...props, resolvingParent: true }))
    const group = screen.getByTestId("panel-group")
    const right = screen.getByTestId("community-thread-split-panel")
    expect(group).toHaveAttribute("data-inert", "true")
    expect(group).toHaveAttribute("data-hidden", "true")
    expect(group).toHaveAttribute("data-persists-layout", "false")
    expect(screen.getByLabelText("Resolving conversation")).toBeInTheDocument()
    renderer.rerender(createElement(ThreadSplitView, props))
    expect(screen.getByTestId("panel-group")).toBe(group)
    expect(screen.getByTestId("community-thread-split-panel")).toBe(right)
    expect(group).toHaveAttribute("data-inert", "undefined")
    expect(screen.queryByLabelText("Resolving conversation")).not.toBeInTheDocument()
    renderer.unmount()
  })
})
