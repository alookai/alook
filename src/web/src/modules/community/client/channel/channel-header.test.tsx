import { describe, expect, it, vi } from "vitest"
import { createRequire } from "node:module"
import React from "react"

type ReactTestInstance = {
  props: Record<string, any>
  findAllByProps: (props: Record<string, unknown>) => ReactTestInstance[]
  findByProps: (props: Record<string, unknown>) => ReactTestInstance
}
type ReactTestRenderer = { root: ReactTestInstance; unmount: () => void }
const TestRenderer = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void | Promise<void>) => void | Promise<void>
  create: (element: React.ReactElement) => ReactTestRenderer
}
const { act } = TestRenderer

vi.mock("@/components/community/settings/create-dialog-shell", async () => {
  const ReactModule = await import("react")
  return {
    CreateDialogShell: ({ title, footer, children }: { title: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) => (
      ReactModule.createElement("div", { "data-testid": "create-dialog-shell", role: "dialog" },
        ReactModule.createElement("div", { className: "text-xs font-normal text-muted-foreground" }, title),
        children,
        footer,
      )
    ),
  }
})

import { ChannelHeader } from "./channel-header"

function renderHeader(onRename?: (name: string) => void | Promise<void>, titleRename = true) {
  return TestRenderer.create(
    React.createElement(ChannelHeader, {
      channel: "forum",
      forum: true,
      rightPanel: null,
      onToggle: () => {},
      tools: { threads: false, pinned: false, members: false },
      breadcrumb: { label: "Original title", onRename, titleRename },
    }),
  )
}

describe("ChannelHeader — forum title dialog", () => {
  it("gates the title edit affordance to the creator and keeps normal threads on Rename", () => {
    let renderer: ReactTestRenderer
    act(() => { renderer = renderHeader() })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    act(() => renderer!.unmount())

    act(() => { renderer = renderHeader(vi.fn()) })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" }).length).toBeGreaterThan(0)
    expect(renderer!.root.findAllByProps({ "aria-label": "Post title" })).toHaveLength(0)
    act(() => renderer!.unmount())

    act(() => { renderer = renderHeader(vi.fn(), false) })
    expect(renderer!.root.findAllByProps({ "aria-label": "Edit post title" })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ "aria-label": "Rename" }).length).toBeGreaterThan(0)
    act(() => renderer!.unmount())
  })

  it("uses the shared create-dialog shell and hero input for post titles", () => {
    let renderer: ReactTestRenderer
    act(() => { renderer = renderHeader(vi.fn()) })
    act(() => renderer!.root.findByProps({ "aria-label": "Edit post title" }).props.onClick())

    expect(renderer!.root.findByProps({ "aria-label": "Post title" }).props.className).toContain("text-[30px]")
    expect(renderer!.root.findByProps({ children: "Edit post title" }).props.className).toBe("text-xs font-normal text-muted-foreground")
    expect(renderer!.root.findByProps({ "data-testid": "create-dialog-shell" })).toBeDefined()

    act(() => renderer!.unmount())
  })

  it("prevents duplicate saves and keeps a failed post-title draft open", async () => {
    let rejectRename!: (reason?: unknown) => void
    let resolveRename!: () => void
    const onRename = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveRename = resolve
      rejectRename = reject
    }))
    let renderer: ReactTestRenderer
    act(() => { renderer = renderHeader(onRename) })
    act(() => renderer!.root.findByProps({ "aria-label": "Edit post title" }).props.onClick())
    act(() => renderer!.root.findByProps({ "aria-label": "Post title" }).props.onChange({ target: { value: "New title" } }))

    const save = renderer!.root.findByProps({ children: "Save" })
    act(() => { void save.props.onClick() })
    act(() => {
      void save.props.onClick()
      renderer!.root.findByProps({ "aria-label": "Post title" }).props.onKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
        nativeEvent: { isComposing: false },
      })
    })
    expect(onRename).toHaveBeenCalledOnce()
    expect(renderer!.root.findByProps({ children: "Save" }).props.disabled).toBe(true)

    await act(async () => { rejectRename(new Error("save failed")); await Promise.resolve() })
    expect(renderer!.root.findByProps({ "aria-label": "Post title" }).props.value).toBe("New title")
    expect(renderer!.root.findByProps({ children: "Save" }).props.disabled).toBe(false)

    act(() => { void renderer!.root.findByProps({ children: "Save" }).props.onClick() })
    expect(onRename).toHaveBeenCalledTimes(2)
    await act(async () => { resolveRename(); await Promise.resolve() })

    act(() => renderer!.unmount())
  })
})
