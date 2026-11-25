import { createElement } from "react"
import type { TiptapEditorHTMLElement } from "@tiptap/react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { tid } from "@/lib/community/testids"
import { Composer, type ComposerProps } from "./composer"

vi.mock("@/hooks/use-hover-capable", () => ({
  useHoverCapable: () => false,
}))

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    channel: "general",
    context: "channel",
    members: [],
    sendContract: "accepted",
    onAcceptSend: () => true,
    ...overrides,
  } as ComposerProps
}

describe("Composer first-character dictation & composition stability", () => {
  it("avoids setOptions/setProps/updateState re-renders and <p> DOM mutations on 1st character during dictation", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!

    expect(editor).toBeDefined()
    expect(editable).toHaveAttribute("aria-label", "Message /general")
    expect(editable).toHaveAttribute("enterkeyhint", "enter")
    expect(paragraph.getAttribute("class")).toBeNull()
    expect(paragraph.getAttribute("data-placeholder")).toBeNull()

    const composerInput = view.getByTestId(tid.composerInput)
    const initialOverlay = view.container.querySelector('[data-slot="composer-placeholder"]')
    expect(initialOverlay).not.toBeNull()
    expect(initialOverlay).toHaveAttribute("aria-hidden", "true")
    expect(initialOverlay).toHaveAttribute("data-placeholder", "Message /general")
    expect(initialOverlay).toHaveClass("chat-placeholder-overlay")
    expect(initialOverlay?.textContent).toBe("")
    expect(composerInput.textContent).toBe("")
    expect(editable.contains(initialOverlay)).toBe(false)

    editable.focus()
    expect(editable).toHaveFocus()

    const setOptionsSpy = vi.spyOn(editor, "setOptions")
    const setPropsSpy = vi.spyOn(editor.view, "setProps")
    const updateStateSpy = vi.spyOn(editor.view, "updateState")
    const paragraphAttrMutations: string[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName) {
          paragraphAttrMutations.push(record.attributeName)
        }
      }
    })
    observer.observe(paragraph, { attributes: true })

    try {
      await act(async () => {
        fireEvent.compositionStart(editable)
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBeNull()
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()
      expect(editable).toHaveFocus()

      // Insert the 1st character (triggers editorHasContent false -> true & sendDisabled true -> false).
      // Reset updateStateSpy after the ProseMirror document transaction itself so we strictly assert
      // that React's resulting re-render invokes 0 setOptions/setProps/updateState calls.
      await act(async () => {
        editor.commands.insertContent("你")
        updateStateSpy.mockClear()
      })
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBeNull()
      expect(editable).toHaveFocus()
      expect(paragraph.getAttribute("class")).toBeNull()
      expect(paragraph.getAttribute("data-placeholder")).toBeNull()

      await act(async () => {
        fireEvent.compositionEnd(editable)
      })
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBeNull()

      // Clear content -> placeholder reappears cleanly with empty composerInput textContent.
      await act(async () => {
        editor.commands.clearContent()
        updateStateSpy.mockClear()
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]'))
        .toHaveAttribute("data-placeholder", "Message /general")
      expect(composerInput.textContent).toBe("")
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()

      // Empty compositionstart -> hides overlay; empty compositionend -> restores overlay.
      await act(async () => {
        fireEvent.compositionStart(editable)
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBeNull()
      await act(async () => {
        fireEvent.compositionEnd(editable)
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]'))
        .toHaveAttribute("data-placeholder", "Message /general")
      expect(composerInput.textContent).toBe("")

      // Dynamic placeholder prop updates overlay + aria-label without calling setOptions.
      await act(async () => {
        view.rerender(createElement(Composer, composerProps({ placeholder: "Ask anything" })))
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]'))
        .toHaveAttribute("data-placeholder", "Ask anything")
      expect(composerInput.textContent).toBe("")
      expect(editable).toHaveAttribute("aria-label", "Ask anything")
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()

      await act(async () => {
        await Promise.resolve()
      })
      expect(paragraphAttrMutations).toEqual([])
    } finally {
      observer.disconnect()
      view.unmount()
    }
  })

  it("keeps setOptions silent on 1st character in forumThreadBody mode when onDirty triggers parent re-render", async () => {
    const onDirty = vi.fn()
    const view = render(createElement(Composer, {
      channel: "forum",
      context: "channel",
      members: [],
      sendContract: "deferred",
      mode: "forumThreadBody",
      placeholder: "What do you want to discuss?",
      onDeferredSubmit: async () => {},
      onDirty,
    }))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    expect(view.container.querySelector('[data-slot="composer-placeholder"]'))
      .toHaveAttribute("data-placeholder", "What do you want to discuss?")
    expect(view.getByTestId(tid.composerInput).textContent).toBe("")

    const setOptionsSpy = vi.spyOn(editor, "setOptions")
    const setPropsSpy = vi.spyOn(editor.view, "setProps")
    const updateStateSpy = vi.spyOn(editor.view, "updateState")
    try {
      editable.focus()
      await act(async () => {
        editor.commands.insertContent("A")
        updateStateSpy.mockClear()
      })
      expect(onDirty).toHaveBeenCalledWith(true)
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBeNull()
      expect(paragraph.getAttribute("class")).toBeNull()
      expect(paragraph.getAttribute("data-placeholder")).toBeNull()
      expect(editable).toHaveFocus()
    } finally {
      view.unmount()
    }
  })
})
