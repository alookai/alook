import { createElement, type ReactNode } from "react"
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer"
import { FORUM_ARCHIVE_TAG, MAX_FORUM_TAG_LENGTH, MAX_FORUM_TAGS_PER_POST } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ breakpoint: "desktop" as "unknown" | "desktop" | "mobile" }))

vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => mocks.breakpoint,
}))

vi.mock("@/components/ui/dialog", async () => {
  const { createElement, Fragment } = await import("react")
  return {
    Dialog: ({ children, ...props }: { children: ReactNode }) =>
      createElement("mock-dialog", props, children),
    DialogTrigger: ({ render }: { render: ReactNode }) => createElement(Fragment, null, render),
    DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: {
      children: ReactNode
      showCloseButton?: boolean
    }) => createElement("section", props, children),
    DialogTitle: ({ children, ...props }: { children: ReactNode }) =>
      createElement("h2", props, children),
  }
})

vi.mock("@/components/ui/popover", async () => {
  const { createElement, Fragment } = await import("react")
  return {
    Popover: ({ children, ...props }: { children: ReactNode }) =>
      createElement("mock-popover", props, children),
    PopoverTrigger: ({ render }: { render: ReactNode }) => createElement(Fragment, null, render),
    PopoverContent: ({ children, ...props }: { children: ReactNode }) =>
      createElement("section", props, children),
  }
})

vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react")
  return {
    Button: ({ children, variant: _variant, size: _size, ...props }: {
      children: ReactNode
      variant?: string
      size?: string
    }) => createElement("button", props, children),
  }
})

vi.mock("@/components/ui/input", async () => {
  const { createElement } = await import("react")
  return {
    Input: (props: Record<string, unknown>) => createElement("input", props),
  }
})

import { PostTagDialog } from "./post-tag-dialog"

type Save = (tags: string[]) => Promise<void> | void

function renderDialog({
  current = [],
  allTags = [],
  onSave = vi.fn(),
  saving = false,
}: {
  current?: string[]
  allTags?: string[]
  onSave?: Save
  saving?: boolean
} = {}) {
  const props = { current, allTags, onSave, saving }
  const element = () => createElement(PostTagDialog, {
    trigger: createElement("button", { type: "button", "data-testid": "trigger" }, "Edit tags"),
    postName: "A post",
    ...props,
  })
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(element())
  })
  return {
    renderer: renderer!,
    onSave,
    rerender: () => act(() => renderer!.update(element())),
  }
}

function shell(root: ReactTestInstance): ReactTestInstance {
  return root.findByType(mocks.breakpoint === "mobile" ? "mock-dialog" : "mock-popover")
}

function setOpen(root: ReactTestInstance, open: boolean): void {
  act(() => shell(root).props.onOpenChange(open))
}

function switchBreakpoint(
  rendered: ReturnType<typeof renderDialog>,
  breakpoint: "desktop" | "mobile",
): void {
  mocks.breakpoint = breakpoint
  rendered.rerender()
}

function byTestId(root: ReactTestInstance, testid: string): ReactTestInstance {
  return root.findByProps({ "data-testid": testid })
}

function tagButton(root: ReactTestInstance, tag: string): ReactTestInstance {
  return byTestId(root, tid.forumTagDialogChip(tag))
}

function input(root: ReactTestInstance): ReactTestInstance {
  return byTestId(root, tid.forumTagDialogInput)
}

function setDraft(root: ReactTestInstance, value: string): void {
  act(() => input(root).props.onChange({ target: { value } }))
}

function pressEnter(root: ReactTestInstance, event: Record<string, unknown> = {}): void {
  act(() => input(root).props.onKeyDown({
    key: "Enter",
    preventDefault: vi.fn(),
    ...event,
  }))
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("PostTagDialog responsive session", () => {
  beforeEach(() => {
    mocks.breakpoint = "desktop"
  })

  it("renders no popup shell until the shared breakpoint resolves", () => {
    mocks.breakpoint = "unknown"
    const { renderer } = renderDialog()
    expect(renderer.root.findAllByType("mock-dialog")).toHaveLength(0)
    expect(renderer.root.findAllByType("mock-popover")).toHaveLength(0)
    expect(byTestId(renderer.root, "trigger")).toBeTruthy()
  })

  it("hides Archived while preserving it through an ordinary tag save", () => {
    const ordinary = Array.from({ length: MAX_FORUM_TAGS_PER_POST }, (_, index) => `tag-${index + 1}`)
    const current = [...ordinary, FORUM_ARCHIVE_TAG]
    const onSave = vi.fn()
    const { renderer } = renderDialog({
      current,
      allTags: [...ordinary, "replacement", FORUM_ARCHIVE_TAG],
      onSave,
    })
    setOpen(renderer.root, true)

    expect(renderer.root.findAllByProps({
      "data-testid": tid.forumTagDialogChip(FORUM_ARCHIVE_TAG),
    })).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Archived")
    expect(JSON.stringify(renderer.toJSON())).not.toContain("STATUS")
    expect(tagButton(renderer.root, "replacement").props.disabled).toBe(true)
    expect(input(renderer.root).props.disabled).toBe(true)
    act(() => tagButton(renderer.root, ordinary[0]!).props.onClick())
    for (const tag of ordinary.slice(1)) {
      expect(tagButton(renderer.root, tag).props["aria-label"]).toBe(`Remove tag ${tag}`)
    }
    setOpen(renderer.root, false)

    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith([...ordinary.slice(1), FORUM_ARCHIVE_TAG])
    expect(shell(renderer.root).props.open).toBe(false)
  })

  it("never exposes an Archived control while editing ordinary tags", () => {
    const onSave = vi.fn()
    const { renderer } = renderDialog({
      current: ["bug", FORUM_ARCHIVE_TAG, "design"],
      allTags: ["bug", "design"],
      onSave,
    })
    setOpen(renderer.root, true)

    expect(JSON.stringify(renderer.toJSON())).not.toContain("Archived")
    act(() => tagButton(renderer.root, "bug").props.onClick())
    expect(tagButton(renderer.root, "design").props["aria-label"]).toBe("Remove tag design")
    setOpen(renderer.root, false)

    expect(onSave).toHaveBeenCalledWith([FORUM_ARCHIVE_TAG, "design"])
  })

  it("normalizes Enter additions, rejects duplicates, and ignores IME or Shift+Enter", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], onSave })
    setOpen(renderer.root, true)

    setDraft(renderer.root, "existing")
    pressEnter(renderer.root)
    expect(input(renderer.root).props.value).toBe("")

    setDraft(renderer.root, "  New-Tag  ")
    pressEnter(renderer.root, { nativeEvent: { isComposing: true } })
    expect(input(renderer.root).props.value).toBe("  New-Tag  ")
    expect(renderer.root.findAllByProps({ "data-testid": tid.forumTagDialogChip("new-tag") })).toHaveLength(0)

    pressEnter(renderer.root, { shiftKey: true })
    expect(input(renderer.root).props.value).toBe("  New-Tag  ")
    pressEnter(renderer.root)
    expect(input(renderer.root).props.value).toBe("")
    expect(tagButton(renderer.root, "new-tag")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("keeps the reserved Archived value out of the ordinary tag input", () => {
    mocks.breakpoint = "mobile"
    const { renderer } = renderDialog({ allTags: [FORUM_ARCHIVE_TAG] })
    setOpen(renderer.root, true)

    setDraft(renderer.root, FORUM_ARCHIVE_TAG)
    pressEnter(renderer.root)

    expect(input(renderer.root).props.value).toBe("")
    expect(renderer.root.findAllByProps({
      "data-testid": tid.forumTagDialogChip(FORUM_ARCHIVE_TAG),
    })).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Archived")
  })

  it.each(["implicit", "close"])("discards a changed mobile session via %s dismissal", (dismissal) => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], allTags: ["existing", "draft"], onSave })
    setOpen(renderer.root, true)
    act(() => tagButton(renderer.root, "draft").props.onClick())

    if (dismissal === "implicit") setOpen(renderer.root, false)
    else {
      act(() => renderer.root.findByProps({ "aria-label": "Close" }).props.onClick())
    }

    expect(onSave).not.toHaveBeenCalled()
    expect(shell(renderer.root).props.open).toBe(false)
    setOpen(renderer.root, true)
    expect(tagButton(renderer.root, "draft").props["aria-label"]).toBe("Add tag draft")
  })

  it("closes a clean mobile session without saving", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], onSave })
    setOpen(renderer.root, true)
    act(() => byTestId(renderer.root, tid.forumTagDialogSave).props.onClick())
    expect(onSave).not.toHaveBeenCalled()
    expect(shell(renderer.root).props.open).toBe(false)
  })

  it("locks one mobile save until it succeeds", async () => {
    mocks.breakpoint = "mobile"
    const pending = deferred()
    const onSave = vi.fn(() => pending.promise)
    const { renderer } = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(renderer.root, true)
    act(() => tagButton(renderer.root, "kept").props.onClick())

    await act(async () => {
      byTestId(renderer.root, tid.forumTagDialogSave).props.onClick()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledOnce()
    expect(byTestId(renderer.root, tid.forumTagDialogSave).props.disabled).toBe(true)
    expect(input(renderer.root).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ "aria-label": "Close" }).props.disabled).toBe(true)
    act(() => byTestId(renderer.root, tid.forumTagDialogSave).props.onClick())
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(shell(renderer.root).props.open).toBe(false)
  })

  it("keeps selected and raw draft state after failure, then retries", async () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined)
    const { renderer } = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(renderer.root, true)
    act(() => tagButton(renderer.root, "kept").props.onClick())
    setDraft(renderer.root, "raw-draft")

    await act(async () => {
      byTestId(renderer.root, tid.forumTagDialogSave).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shell(renderer.root).props.open).toBe(true)
    expect(input(renderer.root).props.value).toBe("raw-draft")
    expect(tagButton(renderer.root, "kept").props["aria-label"]).toBe("Remove tag kept")
    expect(byTestId(renderer.root, tid.forumTagDialogSave).props.disabled).toBe(false)

    await act(async () => {
      byTestId(renderer.root, tid.forumTagDialogSave).props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(shell(renderer.root).props.open).toBe(false)
  })

  it("preserves a mobile session through desktop handoff and saves only on the later desktop close", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(rendered.renderer.root, true)
    act(() => tagButton(rendered.renderer.root, "kept").props.onClick())
    setDraft(rendered.renderer.root, "unfinished")

    switchBreakpoint(rendered, "desktop")
    expect(rendered.renderer.root.findByType("mock-popover").props.open).toBe(true)
    expect(input(rendered.renderer.root).props.value).toBe("unfinished")
    expect(tagButton(rendered.renderer.root, "kept").props["aria-label"]).toBe("Remove tag kept")
    expect(onSave).not.toHaveBeenCalled()

    setOpen(rendered.renderer.root, false)
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith([FORUM_ARCHIVE_TAG, "kept"])
  })

  it("preserves a desktop session through mobile handoff and applies later mobile discard semantics", () => {
    const onSave = vi.fn()
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(rendered.renderer.root, true)
    act(() => tagButton(rendered.renderer.root, "kept").props.onClick())
    setDraft(rendered.renderer.root, "unfinished")

    switchBreakpoint(rendered, "mobile")
    expect(rendered.renderer.root.findByType("mock-dialog").props.open).toBe(true)
    expect(input(rendered.renderer.root).props.value).toBe("unfinished")
    expect(tagButton(rendered.renderer.root, "kept").props["aria-label"]).toBe("Remove tag kept")
    expect(onSave).not.toHaveBeenCalled()

    setOpen(rendered.renderer.root, false)
    expect(onSave).not.toHaveBeenCalled()
    expect(rendered.renderer.root.findByType("mock-dialog").props.open).toBe(false)
  })

  it("keeps one pending save alive through a shell handoff and ignores the stale shell close", async () => {
    mocks.breakpoint = "mobile"
    const pending = deferred()
    const onSave = vi.fn(() => pending.promise)
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(rendered.renderer.root, true)
    act(() => tagButton(rendered.renderer.root, "kept").props.onClick())
    const staleMobileClose = rendered.renderer.root.findByType("mock-dialog").props.onOpenChange

    await act(async () => {
      byTestId(rendered.renderer.root, tid.forumTagDialogSave).props.onClick()
      await Promise.resolve()
    })
    switchBreakpoint(rendered, "desktop")
    expect(rendered.renderer.root.findByType("mock-popover").props.open).toBe(true)
    expect(input(rendered.renderer.root).props.disabled).toBe(true)
    act(() => staleMobileClose(false))
    expect(rendered.renderer.root.findByType("mock-popover").props.open).toBe(true)
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(rendered.renderer.root.findByType("mock-popover").props.open).toBe(false)
    expect(onSave).toHaveBeenCalledOnce()
  })

  it("caps input and contains maximum-length chip labels", () => {
    const tag = "标签".repeat(MAX_FORUM_TAG_LENGTH / 2)
    const { renderer } = renderDialog({ current: [tag], allTags: [tag] })
    setOpen(renderer.root, true)
    setDraft(renderer.root, "x".repeat(MAX_FORUM_TAG_LENGTH + 8))
    expect(input(renderer.root).props.value).toBe("x".repeat(MAX_FORUM_TAG_LENGTH))

    const button = tagButton(renderer.root, tag)
    expect(button.props.className).toContain("max-w-full")
    expect(button.props.title).toBe(`#${tag}`)
    expect(button.props["aria-label"]).toBe(`Remove tag ${tag}`)
    expect(button.findByType("span").props.className).toContain("truncate")
  })

  it("uses a lightweight mobile editor with touch-safe header actions", () => {
    mocks.breakpoint = "mobile"
    const rendered = renderDialog({ allTags: ["compact"] })
    setOpen(rendered.renderer.root, true)

    const surface = byTestId(rendered.renderer.root, tid.forumTagDialog)
    expect(String(surface.props.className)).toContain("w-[calc(100%-2rem)]")
    expect(surface.findByType("h2").children).toEqual(["Tags"])
    expect(surface.findAllByType("span").some((node) => node.children.includes("Add"))).toBe(true)

    const tagField = surface.findAllByType("div").find((node) => (
      String(node.props.className).includes("flex-wrap")
    ))
    expect(String(tagField?.props.className)).not.toContain("border")
    expect(String(tagField?.props.className)).not.toContain("ring")

    const mobileChipClass = String(tagButton(rendered.renderer.root, "compact").props.className)
    expect(mobileChipClass).not.toContain("min-h-11")
    expect(mobileChipClass).not.toContain("min-w-11")
    expect(mobileChipClass).toContain("focus-visible:ring-2")
    expect(mobileChipClass).toContain("active:translate-y-px")
    expect(JSON.stringify(rendered.renderer.toJSON())).not.toContain("Archived")
    expect(JSON.stringify(rendered.renderer.toJSON())).not.toContain("STATUS")
    const close = rendered.renderer.root.findByProps({ "aria-label": "Close" })
    expect(close.props.size).toBe("icon")
    expect(close.props["data-testid"]).toBe(tid.forumTagDialogCancel)
    expect(String(close.props.className)).toContain("size-11")
    const save = byTestId(rendered.renderer.root, tid.forumTagDialogSave)
    expect(save.props.variant).toBe("ghost")
    expect(String(save.props.className)).toContain("h-11")
    expect(String(save.props.className)).toContain("px-2")

    const mobileInput = input(rendered.renderer.root)
    expect(mobileInput.props["aria-label"]).toBe("Add a tag")
    expect(mobileInput.props.autoFocus).toBe(true)
    expect(String(mobileInput.props.className)).toContain("h-11")
    expect(String(mobileInput.props.className)).toContain("border-0")

    switchBreakpoint(rendered, "desktop")
    const popover = rendered.renderer.root.findByType("section")
    expect(popover.props.className).toBe("w-64 space-y-3 p-3")
    expect(String(input(rendered.renderer.root).props.className)).toContain("h-8")
    expect(input(rendered.renderer.root).props["aria-label"]).toBe("Add a tag")
    expect(String(tagButton(rendered.renderer.root, "compact").props.className))
      .not.toContain("min-h-11")
    expect(JSON.stringify(rendered.renderer.toJSON())).not.toContain("Archived")
  })
})
