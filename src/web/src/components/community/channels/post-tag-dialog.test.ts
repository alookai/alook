import { createElement, type ReactNode } from "react"
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer"
import { FORUM_ARCHIVE_TAG, MAX_FORUM_TAG_LENGTH, MAX_FORUM_TAGS_PER_POST } from "@alook/shared"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/popover", async () => {
  const { createElement, Fragment } = await import("react")
  return {
    Popover: ({ children, onOpenChange }: { children: ReactNode; onOpenChange?: (open: boolean) => void }) =>
      createElement("mock-popover", { onOpenChange }, children),
    PopoverTrigger: ({ render }: { render: ReactNode }) => createElement(Fragment, null, render),
    PopoverContent: ({ children, ...props }: { children: ReactNode }) =>
      createElement("div", props, children),
  }
})

vi.mock("@/components/ui/input", async () => {
  const { createElement } = await import("react")
  return {
    Input: (props: Record<string, unknown>) => createElement("input", props),
  }
})

import { PostTagDialog } from "./post-tag-dialog"

function renderDialog({
  current = [],
  allTags = [],
  onSave = vi.fn(),
}: {
  current?: string[]
  allTags?: string[]
  onSave?: (tags: string[]) => void
} = {}) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(PostTagDialog, {
      trigger: createElement("button", { type: "button" }, "Edit tags"),
      postName: "A post",
      current,
      allTags,
      onSave,
    }))
  })
  return { renderer: renderer!, onSave }
}

function buttonText(button: ReactTestInstance): string {
  return button.children.map((child) => (
    typeof child === "string" ? child : buttonText(child)
  )).join("")
}

function tagButton(root: ReactTestInstance, tag: string): ReactTestInstance {
  return root.findAllByType("button").find((button) => buttonText(button) === `#${tag}`)!
}

function setOpen(root: ReactTestInstance, open: boolean): void {
  act(() => root.findByType("mock-popover").props.onOpenChange(open))
}

function pressEnter(input: ReactTestInstance): void {
  act(() => input.props.onKeyDown({
    key: "Enter",
    preventDefault: vi.fn(),
  }))
}

describe("PostTagDialog frontend limits", () => {
  it("always presets Archived and keeps it outside the ordinary tag quota", () => {
    const selected = Array.from({ length: MAX_FORUM_TAGS_PER_POST }, (_, index) => `tag-${index + 1}`)
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: selected, onSave })
    setOpen(renderer.root, true)

    const archived = tagButton(renderer.root, FORUM_ARCHIVE_TAG)
    expect(archived.props.disabled).toBe(false)
    expect(archived.props["data-testid"]).toBe(tid.forumTagDialogChip(FORUM_ARCHIVE_TAG))
    act(() => archived.props.onClick())
    setOpen(renderer.root, false)

    expect(onSave).toHaveBeenCalledWith([...selected, FORUM_ARCHIVE_TAG])
  })

  it("uses the shared length limit and right-aligns the close-save hint", () => {
    const { renderer } = renderDialog()
    const input = renderer.root.findByType("input")
    const hint = renderer.root.findAllByType("p")
      .find((node) => node.children.includes("↵ to add · saves on close"))

    expect(input.props.maxLength).toBe(MAX_FORUM_TAG_LENGTH)
    expect(hint?.props.className).toContain("text-right")
  })

  it("blocks a sixth chip while keeping selected chips removable", () => {
    const selected = Array.from({ length: MAX_FORUM_TAGS_PER_POST }, (_, index) => `tag-${index + 1}`)
    const replacement = "replacement"
    const onSave = vi.fn()
    const { renderer } = renderDialog({
      current: selected,
      allTags: [...selected, replacement],
      onSave,
    })
    setOpen(renderer.root, true)

    expect(tagButton(renderer.root, replacement).props.disabled).toBe(true)
    expect(renderer.root.findByType("input").props.disabled).toBe(true)

    act(() => tagButton(renderer.root, replacement).props.onClick())
    setOpen(renderer.root, false)
    expect(onSave).not.toHaveBeenCalled()

    setOpen(renderer.root, true)
    act(() => tagButton(renderer.root, selected[0]).props.onClick())
    expect(tagButton(renderer.root, replacement).props.disabled).toBe(false)
    expect(renderer.root.findByType("input").props.disabled).toBe(false)
    act(() => tagButton(renderer.root, replacement).props.onClick())
    setOpen(renderer.root, false)

    expect(onSave).toHaveBeenCalledWith([...selected.slice(1), replacement])
  })

  it("caps draft input and blocks duplicate or over-count Enter additions", () => {
    const selected = Array.from({ length: MAX_FORUM_TAGS_PER_POST }, (_, index) => `tag-${index + 1}`)
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: selected, onSave })
    setOpen(renderer.root, true)
    let input = renderer.root.findByType("input")

    act(() => input.props.onChange({ target: { value: "x".repeat(MAX_FORUM_TAG_LENGTH + 8) } }))
    input = renderer.root.findByType("input")
    expect(input.props.value).toBe("x".repeat(MAX_FORUM_TAG_LENGTH))
    pressEnter(input)
    setOpen(renderer.root, false)
    expect(onSave).not.toHaveBeenCalled()

    const duplicateSave = vi.fn()
    const duplicate = renderDialog({ current: ["existing"], onSave: duplicateSave })
    setOpen(duplicate.renderer.root, true)
    let duplicateInput = duplicate.renderer.root.findByType("input")
    act(() => duplicateInput.props.onChange({ target: { value: "existing" } }))
    duplicateInput = duplicate.renderer.root.findByType("input")
    pressEnter(duplicateInput)
    setOpen(duplicate.renderer.root, false)
    expect(duplicateSave).not.toHaveBeenCalled()
  })

  it("adds a valid normalized draft until the shared count cap", () => {
    const current = Array.from({ length: MAX_FORUM_TAGS_PER_POST - 1 }, (_, index) => `tag-${index + 1}`)
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current, onSave })
    setOpen(renderer.root, true)
    let input = renderer.root.findByType("input")

    act(() => input.props.onChange({ target: { value: "  New-Tag  " } }))
    input = renderer.root.findByType("input")
    pressEnter(input)
    expect(renderer.root.findByType("input").props.disabled).toBe(true)
    setOpen(renderer.root, false)

    expect(onSave).toHaveBeenCalledWith([...current, "new-tag"])
  })

  it("does not allow an over-length existing vocabulary chip to be selected", () => {
    const invalid = "x".repeat(MAX_FORUM_TAG_LENGTH + 1)
    const { renderer } = renderDialog({ allTags: [invalid] })
    setOpen(renderer.root, true)
    expect(tagButton(renderer.root, invalid).props.disabled).toBe(true)
  })

  it.each([
    ["English", "w".repeat(MAX_FORUM_TAG_LENGTH)],
    ["Chinese", "标签".repeat(MAX_FORUM_TAG_LENGTH / 2)],
  ])("contains a maximum-length %s chip with an accessible truncated label and fixed remove icon", (_kind, tag) => {
    const { renderer } = renderDialog({ current: [tag], allTags: [tag] })
    setOpen(renderer.root, true)

    const button = tagButton(renderer.root, tag)
    const label = button.findByType("span")
    const removeIcon = button.findByType("svg")

    expect(tag).toHaveLength(MAX_FORUM_TAG_LENGTH)
    expect(button.props.className).toContain("max-w-full")
    expect(button.props.className).toContain("min-w-0")
    expect(button.props["data-testid"]).toBe(tid.forumTagDialogChip(tag))
    expect(button.props.title).toBe(`#${tag}`)
    expect(button.props["aria-label"]).toBe(`Remove tag ${tag}`)
    expect(buttonText(button)).toBe(`#${tag}`)
    expect(label.props.className).toContain("min-w-0")
    expect(label.props.className).toContain("truncate")
    expect(buttonText(label)).toBe(`#${tag}`)
    expect(removeIcon.props.className).toContain("shrink-0")
    expect(removeIcon.props["aria-hidden"]).toBe("true")
  })
})
