import { createElement, type ReactNode } from "react"
import { FORUM_ARCHIVE_TAG, MAX_FORUM_TAG_LENGTH, MAX_FORUM_TAGS_PER_POST } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render, type RenderResult } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  breakpoint: "desktop" as "unknown" | "desktop" | "mobile",
  dialogProps: vi.fn(),
  popoverProps: vi.fn(),
}))

vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => mocks.breakpoint,
}))

vi.mock("@/components/ui/dialog", async () => {
  const { createElement, Fragment } = await import("react")
  return {
    Dialog: ({ children, ...props }: { children: ReactNode }) => {
      mocks.dialogProps(props)
      return createElement("div", { "data-mock-dialog": "" }, children)
    },
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
    Popover: ({ children, ...props }: { children: ReactNode }) => {
      mocks.popoverProps(props)
      return createElement("div", { "data-mock-popover": "" }, children)
    },
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
    }) => createElement("button", {
      ...props,
      "data-variant": _variant,
      "data-size": _size,
    }, children),
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
  const renderer = render(element())
  return {
    renderer,
    onSave,
    rerender: () => renderer.rerender(element()),
  }
}

function shellProps(): Record<string, unknown> {
  const capture = mocks.breakpoint === "mobile" ? mocks.dialogProps : mocks.popoverProps
  const props = capture.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
  if (!props) throw new Error(`Expected ${mocks.breakpoint} shell props`)
  return props
}

function setOpen(open: boolean): void {
  act(() => (shellProps().onOpenChange as (next: boolean) => void)(open))
}

function switchBreakpoint(
  rendered: ReturnType<typeof renderDialog>,
  breakpoint: "desktop" | "mobile",
): void {
  mocks.breakpoint = breakpoint
  rendered.rerender()
}

function byTestId(renderer: RenderResult, testid: string): HTMLElement {
  const element = renderer.container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  if (!element) throw new Error(`Expected test id ${testid}`)
  return element
}

function tagButton(renderer: RenderResult, tag: string): HTMLButtonElement {
  return byTestId(renderer, tid.forumTagDialogChip(tag)) as HTMLButtonElement
}

function input(renderer: RenderResult): HTMLInputElement {
  return byTestId(renderer, tid.forumTagDialogInput) as HTMLInputElement
}

function setDraft(renderer: RenderResult, value: string): void {
  fireEvent.change(input(renderer), { target: { value } })
}

function pressEnter(renderer: RenderResult, event: Record<string, unknown> = {}): void {
  const nativeEvent = event.nativeEvent as { isComposing?: boolean } | undefined
  fireEvent.keyDown(input(renderer), {
    key: "Enter",
    ...(nativeEvent?.isComposing === undefined ? {} : { isComposing: nativeEvent.isComposing }),
    ...event,
    nativeEvent: undefined,
  })
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
    mocks.dialogProps.mockClear()
    mocks.popoverProps.mockClear()
  })

  it("renders no popup shell until the shared breakpoint resolves", () => {
    mocks.breakpoint = "unknown"
    const { renderer } = renderDialog()
    expect(renderer.container.querySelectorAll("[data-mock-dialog]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-mock-popover]")).toHaveLength(0)
    expect(byTestId(renderer, "trigger")).toBeTruthy()
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
    setOpen(true)

    expect(renderer.container.querySelectorAll(
      `[data-testid="${tid.forumTagDialogChip(FORUM_ARCHIVE_TAG)}"]`,
    )).toHaveLength(0)
    expect(renderer.container.textContent).not.toContain("Archived")
    expect(renderer.container.textContent).not.toContain("STATUS")
    expect(tagButton(renderer, "replacement").disabled).toBe(true)
    expect(input(renderer).disabled).toBe(true)
    fireEvent.click(tagButton(renderer, ordinary[0]!))
    for (const tag of ordinary.slice(1)) {
      expect(tagButton(renderer, tag).getAttribute("aria-label")).toBe(`Remove tag ${tag}`)
    }
    setOpen(false)

    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith([...ordinary.slice(1), FORUM_ARCHIVE_TAG])
    expect(shellProps().open).toBe(false)
  })

  it("never exposes an Archived control while editing ordinary tags", () => {
    const onSave = vi.fn()
    const { renderer } = renderDialog({
      current: ["bug", FORUM_ARCHIVE_TAG, "design"],
      allTags: ["bug", "design"],
      onSave,
    })
    setOpen(true)

    expect(renderer.container.textContent).not.toContain("Archived")
    fireEvent.click(tagButton(renderer, "bug"))
    expect(tagButton(renderer, "design").getAttribute("aria-label")).toBe("Remove tag design")
    setOpen(false)

    expect(onSave).toHaveBeenCalledWith([FORUM_ARCHIVE_TAG, "design"])
  })

  it("normalizes Enter additions, rejects duplicates, and ignores IME or Shift+Enter", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], onSave })
    setOpen(true)

    setDraft(renderer, "existing")
    pressEnter(renderer)
    expect(input(renderer).value).toBe("")

    setDraft(renderer, "  New-Tag  ")
    pressEnter(renderer, { nativeEvent: { isComposing: true } })
    expect(input(renderer).value).toBe("  New-Tag  ")
    expect(renderer.container.querySelectorAll(
      `[data-testid="${tid.forumTagDialogChip("new-tag")}"]`,
    )).toHaveLength(0)

    pressEnter(renderer, { shiftKey: true })
    expect(input(renderer).value).toBe("  New-Tag  ")
    pressEnter(renderer)
    expect(input(renderer).value).toBe("")
    expect(tagButton(renderer, "new-tag")).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("keeps the reserved Archived value out of the ordinary tag input", () => {
    mocks.breakpoint = "mobile"
    const { renderer } = renderDialog({ allTags: [FORUM_ARCHIVE_TAG] })
    setOpen(true)

    setDraft(renderer, FORUM_ARCHIVE_TAG)
    pressEnter(renderer)

    expect(input(renderer).value).toBe("")
    expect(renderer.container.querySelectorAll(
      `[data-testid="${tid.forumTagDialogChip(FORUM_ARCHIVE_TAG)}"]`,
    )).toHaveLength(0)
    expect(renderer.container.textContent).not.toContain("Archived")
  })

  it.each(["implicit", "close"])("discards a changed mobile session via %s dismissal", (dismissal) => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], allTags: ["existing", "draft"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(renderer, "draft"))

    if (dismissal === "implicit") setOpen(false)
    else {
      fireEvent.click(renderer.container.querySelector('[aria-label="Close"]')!)
    }

    expect(onSave).not.toHaveBeenCalled()
    expect(shellProps().open).toBe(false)
    setOpen(true)
    expect(tagButton(renderer, "draft").getAttribute("aria-label")).toBe("Add tag draft")
  })

  it("closes a clean mobile session without saving", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const { renderer } = renderDialog({ current: ["existing"], onSave })
    setOpen(true)
    fireEvent.click(byTestId(renderer, tid.forumTagDialogSave))
    expect(onSave).not.toHaveBeenCalled()
    expect(shellProps().open).toBe(false)
  })

  it("locks one mobile save until it succeeds", async () => {
    mocks.breakpoint = "mobile"
    const pending = deferred()
    const onSave = vi.fn(() => pending.promise)
    const { renderer } = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(renderer, "kept"))

    await act(async () => {
      byTestId(renderer, tid.forumTagDialogSave).click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledOnce()
    expect((byTestId(renderer, tid.forumTagDialogSave) as HTMLButtonElement).disabled).toBe(true)
    expect(input(renderer).disabled).toBe(true)
    expect((renderer.container.querySelector('[aria-label="Close"]') as HTMLButtonElement).disabled)
      .toBe(true)
    fireEvent.click(byTestId(renderer, tid.forumTagDialogSave))
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(shellProps().open).toBe(false)
  })

  it("keeps selected and raw draft state after failure, then retries", async () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined)
    const { renderer } = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(renderer, "kept"))
    setDraft(renderer, "raw-draft")

    await act(async () => {
      byTestId(renderer, tid.forumTagDialogSave).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shellProps().open).toBe(true)
    expect(input(renderer).value).toBe("raw-draft")
    expect(tagButton(renderer, "kept").getAttribute("aria-label")).toBe("Remove tag kept")
    expect((byTestId(renderer, tid.forumTagDialogSave) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      byTestId(renderer, tid.forumTagDialogSave).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(shellProps().open).toBe(false)
  })

  it("preserves a mobile session through desktop handoff and saves only on the later desktop close", () => {
    mocks.breakpoint = "mobile"
    const onSave = vi.fn()
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(rendered.renderer, "kept"))
    setDraft(rendered.renderer, "unfinished")

    switchBreakpoint(rendered, "desktop")
    expect(shellProps().open).toBe(true)
    expect(input(rendered.renderer).value).toBe("unfinished")
    expect(tagButton(rendered.renderer, "kept").getAttribute("aria-label")).toBe("Remove tag kept")
    expect(onSave).not.toHaveBeenCalled()

    setOpen(false)
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledWith([FORUM_ARCHIVE_TAG, "kept"])
  })

  it("preserves a desktop session through mobile handoff and applies later mobile discard semantics", () => {
    const onSave = vi.fn()
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(rendered.renderer, "kept"))
    setDraft(rendered.renderer, "unfinished")

    switchBreakpoint(rendered, "mobile")
    expect(shellProps().open).toBe(true)
    expect(input(rendered.renderer).value).toBe("unfinished")
    expect(tagButton(rendered.renderer, "kept").getAttribute("aria-label")).toBe("Remove tag kept")
    expect(onSave).not.toHaveBeenCalled()

    setOpen(false)
    expect(onSave).not.toHaveBeenCalled()
    expect(shellProps().open).toBe(false)
  })

  it("keeps one pending save alive through a shell handoff and ignores the stale shell close", async () => {
    mocks.breakpoint = "mobile"
    const pending = deferred()
    const onSave = vi.fn(() => pending.promise)
    const rendered = renderDialog({ current: [FORUM_ARCHIVE_TAG], allTags: ["kept"], onSave })
    setOpen(true)
    fireEvent.click(tagButton(rendered.renderer, "kept"))
    const staleMobileClose = shellProps().onOpenChange as (next: boolean) => void

    await act(async () => {
      byTestId(rendered.renderer, tid.forumTagDialogSave).click()
      await Promise.resolve()
    })
    switchBreakpoint(rendered, "desktop")
    expect(shellProps().open).toBe(true)
    expect(input(rendered.renderer).disabled).toBe(true)
    act(() => staleMobileClose(false))
    expect(shellProps().open).toBe(true)
    expect(onSave).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(shellProps().open).toBe(false)
    expect(onSave).toHaveBeenCalledOnce()
  })

  it("caps input and contains maximum-length chip labels", () => {
    const tag = "标签".repeat(MAX_FORUM_TAG_LENGTH / 2)
    const { renderer } = renderDialog({ current: [tag], allTags: [tag] })
    setOpen(true)
    setDraft(renderer, "x".repeat(MAX_FORUM_TAG_LENGTH + 8))
    expect(input(renderer).value).toBe("x".repeat(MAX_FORUM_TAG_LENGTH))

    const button = tagButton(renderer, tag)
    expect(button.className).toContain("max-w-full")
    expect(button.title).toBe(`#${tag}`)
    expect(button.getAttribute("aria-label")).toBe(`Remove tag ${tag}`)
    expect(button.querySelector("span")?.className).toContain("truncate")
  })

  it("uses a lightweight mobile editor with touch-safe header actions", () => {
    mocks.breakpoint = "mobile"
    const rendered = renderDialog({ allTags: ["compact"] })
    setOpen(true)

    const surface = byTestId(rendered.renderer, tid.forumTagDialog)
    expect(surface.className).toContain("w-[calc(100%-2rem)]")
    expect(surface.querySelector("h2")?.textContent).toBe("Tags")
    expect([...surface.querySelectorAll("span")].some((node) => node.textContent === "Add"))
      .toBe(true)

    const tagField = [...surface.querySelectorAll("div")].find((node) => (
      node.className.includes("flex-wrap")
    ))
    expect(tagField?.className).not.toContain("border")
    expect(tagField?.className).not.toContain("ring")

    const mobileChipClass = tagButton(rendered.renderer, "compact").className
    expect(mobileChipClass).not.toContain("min-h-11")
    expect(mobileChipClass).not.toContain("min-w-11")
    expect(mobileChipClass).toContain("focus-visible:ring-2")
    expect(mobileChipClass).toContain("active:translate-y-px")
    expect(rendered.renderer.container.textContent).not.toContain("Archived")
    expect(rendered.renderer.container.textContent).not.toContain("STATUS")
    const close = rendered.renderer.container.querySelector('[aria-label="Close"]')!
    expect(close.getAttribute("data-size")).toBe("icon")
    expect(close.getAttribute("data-testid")).toBe(tid.forumTagDialogCancel)
    expect(close.className).toContain("size-11")
    const save = byTestId(rendered.renderer, tid.forumTagDialogSave)
    expect(save.getAttribute("data-variant")).toBe("ghost")
    expect(save.className).toContain("h-11")
    expect(save.className).toContain("px-2")

    const mobileInput = input(rendered.renderer)
    expect(mobileInput.getAttribute("aria-label")).toBe("Add a tag")
    expect(document.activeElement).toBe(mobileInput)
    expect(mobileInput.className).toContain("h-11")
    expect(mobileInput.className).toContain("border-0")

    switchBreakpoint(rendered, "desktop")
    const popover = rendered.renderer.container.querySelector("section")!
    expect(popover.className).toBe("w-64 space-y-3 p-3")
    expect(input(rendered.renderer).className).toContain("h-8")
    expect(input(rendered.renderer).getAttribute("aria-label")).toBe("Add a tag")
    expect(tagButton(rendered.renderer, "compact").className)
      .not.toContain("min-h-11")
    expect(rendered.renderer.container.textContent).not.toContain("Archived")
  })
})
