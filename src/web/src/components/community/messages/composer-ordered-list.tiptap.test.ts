import { Node, Editor } from "@tiptap/react"
import type { EditorState } from "@tiptap/pm/state"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  composerOrderedListInputRule,
  composerDocumentExtensions,
  preserveComposerPlainTextPaste,
  serializeComposerDocument,
} from "./composer-ordered-list"

const TestMention = Node.create({
  name: "mention",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { label: { default: null } }
  },
  renderText({ node }) {
    return `@${node.attrs.label}`
  },
  renderHTML({ node }) {
    return ["span", `@${node.attrs.label}`]
  },
})

const TestChannelRef = Node.create({
  name: "channelRef",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { path: { default: null } }
  },
  renderText({ node }) {
    return node.attrs.path
  },
  renderHTML({ node }) {
    return ["span", node.attrs.path]
  },
})

const editors: Editor[] = []

function createChatEditor(content?: Parameters<typeof Editor>[0]["content"]): Editor {
  const editor = new Editor({
    element: null,
    extensions: [
      ...composerDocumentExtensions(false),
      TestMention,
      TestChannelRef,
    ],
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  })
  editors.push(editor)
  return editor
}

function matchOrderedMarker(editor: Editor, marker: string) {
  const rule = composerOrderedListInputRule(editor.schema.nodes.orderedList)
  return typeof rule.find === "function"
    ? rule.find(marker)
    : rule.find.exec(marker)
}

function applyOrderedMarker(editor: Editor, marker: string) {
  const rule = composerOrderedListInputRule(editor.schema.nodes.orderedList)
  const match = matchOrderedMarker(editor, marker)
  if (!match) throw new Error(`Expected ${marker} to match the ordered-list rule`)

  const markerText = marker.slice(0, -1)
  let markerStart = -1
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "paragraph" && node.textContent === markerText) {
      markerStart = position + 1
    }
  })
  if (markerStart < 0) throw new Error(`Missing marker paragraph for ${marker}`)

  const transaction = editor.state.tr
  const chainableState = Object.create(editor.state) as EditorState
  Object.defineProperty(chainableState, "tr", { get: () => transaction })
  rule.handler({
    state: chainableState,
    range: { from: markerStart, to: markerStart + markerText.length },
    match: match as never,
    commands: {} as never,
    chain: (() => ({})) as never,
    can: (() => ({})) as never,
  })
  return editor.state.apply(transaction).doc.toJSON()
}

function paragraph(text?: string) {
  return {
    type: "paragraph",
    ...(text ? { content: [{ type: "text", text }] } : {}),
  }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe("ComposerOrderedList", () => {
  it("installs exactly one orderedList node in chat and none in forum mode", () => {
    const chat = createChatEditor()
    expect(
      chat.extensionManager.extensions.filter(({ name }) => name === "orderedList"),
    ).toHaveLength(1)
    expect(
      chat.extensionManager.extensions.some(({ name }) => name === "trailingNode"),
    ).toBe(false)
    expect(
      chat.extensionManager.plugins.some(({ spec }) => spec.isInputRules),
    ).toBe(true)
    const forum = new Editor({
      element: null,
      extensions: composerDocumentExtensions(true),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })
    editors.push(forum)
    expect(forum.schema.nodes.orderedList).toBeUndefined()
    expect(
      forum.extensionManager.extensions.some(({ name }) => name === "trailingNode"),
    ).toBe(true)
  })

  it.each(["1. ", "9. ", "42. "])(
    "wraps canonical positive marker %s with its exact start",
    (marker) => {
      const editor = createChatEditor()
      const markerEditor = createChatEditor({
        type: "doc",
        content: [paragraph(marker.slice(0, -1))],
      })
      expect(applyOrderedMarker(markerEditor, marker)).toMatchObject({
        content: [{
          type: "orderedList",
          attrs: { start: Number.parseInt(marker, 10) },
          content: [{ type: "listItem" }],
        }],
      })
      expect(matchOrderedMarker(editor, marker)).not.toBeNull()
    },
  )

  it.each(["0. ", "01. ", "1) ", "a. ", "一. ", "- ", "* ", "word 1. "])(
    "leaves non-canonical marker %s as literal paragraph text",
    (marker) => {
      const editor = createChatEditor()
      expect(matchOrderedMarker(editor, marker)).toBeNull()
    },
  )

  it("joins only the next canonical number onto an existing list", () => {
    const editor = createChatEditor({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 9 },
          content: [{ type: "listItem", content: [paragraph("first")] }],
        },
        paragraph("10."),
      ],
    })
    expect(applyOrderedMarker(editor, "10. ").content).toMatchObject([{
      type: "orderedList",
      attrs: { start: 9 },
      content: [
        { type: "listItem", content: [paragraph("first")] },
        { type: "listItem", content: [paragraph()] },
      ],
    }])
  })

  it("starts a separate mismatched list without renumbering the earlier list", () => {
    const editor = createChatEditor({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [{
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "earlier" }],
            }],
          }],
        },
        paragraph("9."),
      ],
    })
    const content = applyOrderedMarker(editor, "9. ").content as Array<{
      type: string
      attrs?: { start?: number }
    }>
    expect(content.map((node) => ({
      type: node.type,
      start: node.attrs?.start,
    }))).toEqual([
      { type: "orderedList", start: 3 },
      { type: "orderedList", start: 9 },
    ])
  })
})

describe("preserveComposerPlainTextPaste", () => {
  it.each([
    { text: "", html: undefined },
    { text: "1. alpha", html: "<p>1. alpha</p>" },
  ])("does not consume non-text-only paste %#", ({ text, html }) => {
    const dispatch = vi.fn()

    expect(
      preserveComposerPlainTextPaste(
        { dispatch } as never,
        text,
        html,
        {} as never,
      ),
    ).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("dispatches the exact parsed Slice with paste metadata", () => {
    const slice = { content: "parsed plain text" }
    const transaction = {
      replaceSelection: vi.fn(),
      scrollIntoView: vi.fn(),
      setMeta: vi.fn(),
    }
    transaction.replaceSelection.mockReturnValue(transaction)
    transaction.scrollIntoView.mockReturnValue(transaction)
    transaction.setMeta.mockReturnValue(transaction)
    const dispatch = vi.fn()
    const view = { state: { tr: transaction }, dispatch }

    expect(
      preserveComposerPlainTextPaste(
        view as never,
        "1. alpha\n2. beta",
        undefined,
        slice as never,
      ),
    ).toBe(true)
    expect(transaction.replaceSelection).toHaveBeenCalledWith(slice)
    expect(transaction.scrollIntoView).toHaveBeenCalledOnce()
    expect(transaction.setMeta).toHaveBeenNthCalledWith(1, "paste", true)
    expect(transaction.setMeta).toHaveBeenNthCalledWith(2, "uiEvent", "paste")
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(transaction)
  })
})

describe("serializeComposerDocument", () => {
  it("pins nested content-column indentation, block boundaries, and pill text", () => {
    const editor = createChatEditor({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 9 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "orderedList",
                  attrs: { start: 3 },
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            { type: "mention", attrs: { label: "Alice#0001" } },
                            { type: "hardBreak" },
                            { type: "text", text: "child hard break " },
                            {
                              type: "channelRef",
                              attrs: { path: "/demo#1234/general" },
                            },
                          ],
                        },
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "second paragraph" }],
                        },
                        {
                          type: "orderedList",
                          attrs: { start: 1 },
                          content: [{
                            type: "listItem",
                            content: [{
                              type: "paragraph",
                              content: [{ type: "text", text: "grandchild" }],
                            }],
                          }],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: "next" }],
                      }],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              }],
            },
          ],
        },
      ],
    })

    expect(serializeComposerDocument(editor)).toBe([
      "9. parent",
      "   3. @Alice#0001",
      "      child hard break /demo#1234/general",
      "",
      "      second paragraph",
      "      1. grandchild",
      "   4. next",
      "10. sibling",
    ].join("\n"))
  })

  it("uses the actual multi-digit marker width and preserves top-level block gaps", () => {
    const editor = createChatEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "orderedList",
          attrs: { start: 10 },
          content: [{
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "parent" }],
              },
              {
                type: "orderedList",
                attrs: { start: 1 },
                content: [{
                  type: "listItem",
                  content: [{
                    type: "paragraph",
                    content: [{ type: "text", text: "child" }],
                  }],
                }],
              },
            ],
          }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    })

    expect(serializeComposerDocument(editor)).toBe(
      "before\n\n10. parent\n    1. child\n\nafter",
    )
  })
})
