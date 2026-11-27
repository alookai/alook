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
    expect(initialOverlay).toHaveAttribute("data-visible", "true")
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
    const placeholderRemovals: Node[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName) {
          paragraphAttrMutations.push(record.attributeName)
        }
      }
    })
    const wrapperObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (removed === initialOverlay) {
            placeholderRemovals.push(removed)
          }
        }
      }
    })
    observer.observe(paragraph, { attributes: true })
    wrapperObserver.observe(composerInput, { childList: true, subtree: true })

    try {
      await act(async () => {
        fireEvent.compositionStart(editable)
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(initialOverlay)
      expect(initialOverlay).toHaveAttribute("data-visible", "false")
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
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(initialOverlay)
      expect(initialOverlay).toHaveAttribute("data-visible", "false")
      expect(editable).toHaveFocus()
      expect(paragraph.getAttribute("class")).toBeNull()
      expect(paragraph.getAttribute("data-placeholder")).toBeNull()

      await act(async () => {
        fireEvent.compositionEnd(editable)
      })
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(initialOverlay)
      expect(initialOverlay).toHaveAttribute("data-visible", "false")

      // Clear content -> placeholder becomes visible again cleanly with empty composerInput textContent.
      await act(async () => {
        editor.commands.clearContent()
        updateStateSpy.mockClear()
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(initialOverlay)
      expect(initialOverlay).toHaveAttribute("data-placeholder", "Message /general")
      expect(initialOverlay).toHaveAttribute("data-visible", "true")
      expect(composerInput.textContent).toBe("")
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()

      // Empty compositionstart -> hides overlay via CSS; empty compositionend -> restores visibility.
      await act(async () => {
        fireEvent.compositionStart(editable)
      })
      expect(initialOverlay).toHaveAttribute("data-visible", "false")
      await act(async () => {
        fireEvent.compositionEnd(editable)
      })
      expect(initialOverlay).toHaveAttribute("data-visible", "true")
      expect(composerInput.textContent).toBe("")

      // Dynamic placeholder prop updates overlay + aria-label without calling setOptions.
      await act(async () => {
        view.rerender(createElement(Composer, composerProps({ placeholder: "Ask anything" })))
      })
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(initialOverlay)
      expect(initialOverlay).toHaveAttribute("data-placeholder", "Ask anything")
      expect(initialOverlay).toHaveAttribute("data-visible", "true")
      expect(composerInput.textContent).toBe("")
      expect(editable).toHaveAttribute("aria-label", "Ask anything")
      expect(setOptionsSpy).not.toHaveBeenCalled()
      expect(setPropsSpy).not.toHaveBeenCalled()
      expect(updateStateSpy).not.toHaveBeenCalled()

      await act(async () => {
        await Promise.resolve()
      })
      expect(paragraphAttrMutations).toEqual([])
      expect(placeholderRemovals).toEqual([])
    } finally {
      observer.disconnect()
      wrapperObserver.disconnect()
      view.unmount()
    }
  })

  it("adopts a browser-inserted 1st-character Text node in-place without removing it or calling Selection.collapse", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    editable.focus()

    // Simulate WebKit/Chromium inserting a direct #text("你") into empty <p> and placing
    // the DOM selection at offset 1 on that browser-owned Text node before ProseMirror flushes.
    const browserTextNode = document.createTextNode("你")
    paragraph.replaceChildren(browserTextNode)
    const selection = window.getSelection()!
    selection.collapse(browserTextNode, 1)

    const collapseSpy = vi.spyOn(Selection.prototype, "collapse")
    const removeAllRangesSpy = vi.spyOn(Selection.prototype, "removeAllRanges")
    const removedTextNodes: Node[] = []
    const textObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            removedTextNodes.push(node)
          }
        }
      }
    })
    textObserver.observe(paragraph, { childList: true })

    try {
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText("你", 1, 1))
      })
      expect(removedTextNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect((browserTextNode as unknown as { pmViewDesc?: unknown }).pmViewDesc).toBeDefined()
      expect(collapseSpy).not.toHaveBeenCalled()
      expect(removeAllRangesSpy).not.toHaveBeenCalled()
      expect(editor.getText()).toBe("你")
    } finally {
      textObserver.disconnect()
      collapseSpy.mockRestore()
      removeAllRangesSpy.mockRestore()
      view.unmount()
    }
  })

  it("adopts browser 1st-character Text node and preserves trailing <br> when Selection points to <p> offset 1", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    const trailingBreak = paragraph.querySelector("br.ProseMirror-trailingBreak")
    expect(trailingBreak).not.toBeNull()
    editable.focus()

    // Simulate WebKit/browser dictation inserting #text("你") before the existing trailing <br>
    // while leaving Selection on the <p> element itself at offset 1 (after the inserted text node).
    const browserTextNode = document.createTextNode("你")
    paragraph.insertBefore(browserTextNode, trailingBreak)
    const selection = window.getSelection()!
    selection.collapse(paragraph, 1)

    const collapseSpy = vi.spyOn(Selection.prototype, "collapse")
    const removeAllRangesSpy = vi.spyOn(Selection.prototype, "removeAllRanges")
    const removedNodes: Node[] = []
    const childObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          removedNodes.push(node)
        }
      }
    })
    childObserver.observe(paragraph, { childList: true })

    try {
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText("你", 1, 1))
      })
      expect(removedNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect((browserTextNode as unknown as { pmViewDesc?: unknown }).pmViewDesc).toBeDefined()
      expect(paragraph.contains(trailingBreak)).toBe(true)
      expect(collapseSpy).not.toHaveBeenCalled()
      expect(removeAllRangesSpy).not.toHaveBeenCalled()
      expect(editor.getText()).toBe("你")
    } finally {
      childObserver.disconnect()
      collapseSpy.mockRestore()
      removeAllRangesSpy.mockRestore()
      view.unmount()
    }
  })

  it("adopts browser 1st-character Text node in-place when transient dictation nodeValue differs from committed text", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    const trailingBreak = paragraph.querySelector("br.ProseMirror-trailingBreak")
    expect(trailingBreak).not.toBeNull()
    editable.focus()

    // Simulate transient dictation text / auto-punctuation mismatch ("你 " in DOM vs "你" committed).
    const browserTextNode = document.createTextNode("你 ")
    paragraph.insertBefore(browserTextNode, trailingBreak)
    const selection = window.getSelection()!
    selection.collapse(browserTextNode, 1)

    const removedNodes: Node[] = []
    const childObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          removedNodes.push(node)
        }
      }
    })
    childObserver.observe(paragraph, { childList: true })

    try {
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText("你", 1, 1))
      })
      expect(removedNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect(browserTextNode.nodeValue).toBe("你")
      expect((browserTextNode as unknown as { pmViewDesc?: unknown }).pmViewDesc).toBeDefined()
      expect(editor.getText()).toBe("你")
    } finally {
      childObserver.disconnect()
      view.unmount()
    }
  })

  it("keeps <p> childList stable across 0 -> 1 -> 2 -> 0 character transitions without removing the trailing <br>", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    const trailingBreak = paragraph.querySelector("br.ProseMirror-trailingBreak")
    const overlay = view.container.querySelector('[data-slot="composer-placeholder"]')
    expect(trailingBreak).not.toBeNull()
    editable.focus()

    const browserTextNode = document.createTextNode("你")
    paragraph.insertBefore(browserTextNode, trailingBreak)
    window.getSelection()!.collapse(browserTextNode, 1)

    const removedNodes: Node[] = []
    const childObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          removedNodes.push(node)
        }
      }
    })
    childObserver.observe(paragraph, { childList: true })

    try {
      // 0 -> 1
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText("你", 1, 1))
      })
      expect(removedNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect(paragraph.contains(trailingBreak)).toBe(true)

      // 1 -> 2
      browserTextNode.nodeValue = "你好"
      window.getSelection()!.collapse(browserTextNode, 2)
      await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText("好", 2, 2))
      })
      expect(removedNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect(paragraph.contains(trailingBreak)).toBe(true)
      expect(editor.getText()).toBe("你好")

      // 2 -> 0 (delete back to empty)
      await act(async () => {
        editor.commands.clearContent()
      })
      expect(editor.isEmpty).toBe(true)
      expect(paragraph.querySelector("br.ProseMirror-trailingBreak")).not.toBeNull()
      expect(overlay).toHaveAttribute("data-visible", "true")
    } finally {
      childObserver.disconnect()
      view.unmount()
    }
  })

  it("reconciles a real DOMObserver flush for 1st-character insertion before trailing <br> with Selection on <p> offset 1", async () => {
    const view = render(createElement(Composer, composerProps()))
    await waitFor(() => {
      expect(view.container.querySelector(".tiptap p")).not.toBeNull()
    })

    const editable = view.container.querySelector<TiptapEditorHTMLElement>(".tiptap")!
    const editor = editable.editor!
    const paragraph = editable.querySelector("p")!
    const trailingBreak = paragraph.querySelector("br.ProseMirror-trailingBreak")
    expect(trailingBreak).not.toBeNull()
    editable.focus()

    // Insert the browser-owned Text node before the trailing <br> and place Selection on <p> offset 1,
    // then flush ProseMirror's real DOMObserver -> readDOMChange -> parseBetween -> updateState pipeline.
    const browserTextNode = document.createTextNode("你")
    paragraph.insertBefore(browserTextNode, trailingBreak)
    window.getSelection()!.collapse(paragraph, 1)

    const collapseSpy = vi.spyOn(Selection.prototype, "collapse")
    const removeAllRangesSpy = vi.spyOn(Selection.prototype, "removeAllRanges")
    const removedNodes: Node[] = []
    const childObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          removedNodes.push(node)
        }
      }
    })
    childObserver.observe(paragraph, { childList: true })

    try {
      await act(async () => {
        ;(editor.view as unknown as { domObserver: { flush: () => void } }).domObserver.flush()
      })
      expect(editor.getText()).toBe("你")
      expect(removedNodes).toEqual([])
      expect(paragraph.firstChild).toBe(browserTextNode)
      expect((browserTextNode as unknown as { pmViewDesc?: unknown }).pmViewDesc).toBeDefined()
      expect(paragraph.contains(trailingBreak)).toBe(true)
      expect(collapseSpy).not.toHaveBeenCalled()
      expect(removeAllRangesSpy).not.toHaveBeenCalled()
    } finally {
      childObserver.disconnect()
      collapseSpy.mockRestore()
      removeAllRangesSpy.mockRestore()
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
    const overlay = view.container.querySelector('[data-slot="composer-placeholder"]')
    expect(overlay).toHaveAttribute("data-placeholder", "What do you want to discuss?")
    expect(overlay).toHaveAttribute("data-visible", "true")
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
      expect(view.container.querySelector('[data-slot="composer-placeholder"]')).toBe(overlay)
      expect(overlay).toHaveAttribute("data-visible", "false")
      expect(paragraph.getAttribute("class")).toBeNull()
      expect(paragraph.getAttribute("data-placeholder")).toBeNull()
      expect(editable).toHaveFocus()
    } finally {
      view.unmount()
    }
  })
})
