import { createElement, forwardRef, createRef } from "react"
import { Editor, EditorContent, type JSONContent } from "@tiptap/react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { buildCommunityMentionExtension, EMPTY_MENTION_STATE } from "@/lib/community/mention-extension"
import { readComposerDraft, writeComposerDraft } from "@/lib/community/composer-draft"
import { composerDocumentExtensions, serializeComposerDocument } from "./composer-ordered-list"
import { prependReplyMention } from "./prepend-reply-mention"
import { useComposerController } from "./use-composer-controller"
import type { ComposerHandle, ComposerProps } from "./composer-types"

const profiles = vi.hoisted(() => ({ value: new Map<string, { id: string; name: string; discriminator: string }>() }))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: (userIds?: readonly string[]) => userIds === undefined
    ? profiles.value
    : new Map([...profiles.value].filter(([id]) => userIds.includes(id))),
}))

const author = { id: "author", label: "Same#1234" }
const mentionNode = (id = author.id, label = author.label): JSONContent => ({ type: "mention", attrs: { id, label } })
const text = (value: string): JSONContent => ({ type: "text", text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })
const editors: Editor[] = []

function makeEditor(content = doc(paragraph())) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...composerDocumentExtensions(false),
      buildCommunityMentionExtension({
        editorRef: { current: null }, canSuggest: () => false,
        membersRef: { current: [] }, contextRef: { current: "dm" },
        popupRef: { current: EMPTY_MENTION_STATE }, setPopup: () => {},
      }),
    ],
    content,
  })
  editors.push(editor)
  return editor
}

function mentionIds(editor: Editor) {
  const ids: string[] = []
  editor.state.doc.descendants((node) => { if (node.type.name === "mention") ids.push(node.attrs.id) })
  return ids
}

beforeEach(() => {
  localStorage.clear()
  const rect = new DOMRect(10, 20, 1, 18)
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect })
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect] })
  profiles.value = new Map([["author", { id: "author", name: "Same", discriminator: "1234" }]])
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  delete (Range.prototype as Partial<Range>).getClientRects
})

describe("native reply mention transaction", () => {
  it.each(["", "draft"])("prepends a visible real atom to %s and reuses it", (draft) => {
    const editor = makeEditor(doc(paragraph(...(draft ? [text(draft)] : []))))
    prependReplyMention(editor, author)
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("mention")
    expect(serializeComposerDocument(editor)).toBe(`@Same#1234 ${draft}`)
    const before = editor.getJSON()
    prependReplyMention(editor, author)
    expect(editor.getJSON()).toEqual(before)
    expect(mentionIds(editor)).toEqual(["author"])
  })

  it("reuses an old membership atom by its complete account handle when the roster is empty", () => {
    const editor = makeEditor(doc(paragraph(text("before "), mentionNode("legacy-membership"), text(" after"))))
    prependReplyMention(editor, author)
    expect(mentionIds(editor)).toEqual(["legacy-membership"])
    expect(serializeComposerDocument(editor)).toBe("@Same#1234 before  after")
  })

  it("moves a membership-ID atom once and preserves structured draft and other identities", () => {
    const editor = makeEditor(doc(
      paragraph(text("start "), mentionNode("other", "Same#5678"), text(" keep")),
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [
        paragraph(text("item "), mentionNode("member-author"), text(" end")),
      ] }] },
    ))
    const before = editor.getJSON()
    prependReplyMention(editor, author, ["author", "member-author"])
    expect(mentionIds(editor)).toEqual(["member-author", "other"])
    expect(serializeComposerDocument(editor)).toBe("@Same#1234 start @Same#5678 keep\n\n3. item  end")
    const after = editor.getJSON()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.getJSON()).toEqual(after)
  })

  it("preserves an initial list and separates the reply operation from preceding typing", () => {
    const list = { type: "orderedList", attrs: { start: 9 }, content: [{ type: "listItem", content: [paragraph(text("item"))] }] }
    const editor = makeEditor(doc(list))
    editor.commands.insertContent("typed")
    const before = editor.getJSON()
    prependReplyMention(editor, author)
    expect(editor.getJSON().content?.[1]).toEqual(before.content?.[0])
    expect(mentionIds(editor)).toEqual(["author"])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
  })

  it("switches same-name targets by ID, preserving the previous mention and whitespace", () => {
    const editor = makeEditor(doc(paragraph(mentionNode(), text(" draft"))))
    prependReplyMention(editor, { id: "other", label: "Same#5678" })
    expect(mentionIds(editor)).toEqual(["other", "author"])
    expect(serializeComposerDocument(editor)).toBe("@Same#5678 @Same#1234 draft")
    prependReplyMention(editor, author)
    expect(mentionIds(editor)).toEqual(["author", "other"])
  })
})

let view: ReturnType<typeof useComposerController>
const Harness = forwardRef<ComposerHandle, ComposerProps>(function Harness(props, ref) {
  view = useComposerController(props, ref)
  return createElement(EditorContent, { editor: view.editor })
})
const reply = { authorId: "author", authorName: "Same", text: "original" }
function props(onAcceptSend = vi.fn(() => true)): ComposerProps {
  return { channel: "dm", context: "dm", members: [], sendContract: "accepted", onAcceptSend, draftKey: "dm-reply" }
}

describe("real common composer reply lifecycle", () => {
  it.each(["canonical user", "membership"])("does not reuse a restored conflicting %s identity", async (identity) => {
    profiles.value.set("other", { id: "other", name: "Other", discriminator: "5678" })
    const id = identity === "canonical user" ? "other" : "member-other"
    const saved = makeEditor(doc(paragraph(text("before "), mentionNode(id), text(" after")))).getJSON()
    writeComposerDraft("viewer:dm-reply", saved)
    const accept = vi.fn(() => true)
    const base = props(accept)
    if (identity === "membership") base.members = [{
      id, userId: "other", name: "Other", discriminator: "5678", avatar: "", avatarVersion: 0,
      status: "offline", sub: "", role: "member",
    }]
    await act(async () => { render(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual(["author", id])
    const body = "@Same#1234 before @Same#1234 after"
    expect(serializeComposerDocument(view.editor!)).toBe(body)
    expect(readComposerDraft("viewer:dm-reply")).toEqual(view.editor!.getJSON())
    const after = view.editor!.getJSON()
    await act(async () => { expect(view.editor!.commands.undo()).toBe(true) })
    expect(view.editor!.getJSON()).toEqual(saved)
    await act(async () => { expect(view.editor!.commands.redo()).toBe(true) })
    expect(view.editor!.getJSON()).toEqual(after)
    await act(async () => { view.onSend() })
    expect(accept).toHaveBeenCalledWith(body, undefined, undefined)
  })

  it.each([true, false])("reuses a restored legacy target atom with current mapping=%s", async (mapped) => {
    const id = "member-author"
    writeComposerDraft("viewer:dm-reply", doc(paragraph(text("before "), mentionNode(id), text(" after"))))
    const base = props()
    if (mapped) base.members = [{
      id, userId: "author", name: "Same", discriminator: "1234", avatar: "", avatarVersion: 0,
      status: "offline", sub: "", role: "member",
    }]
    await act(async () => { render(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual([id])
    expect(serializeComposerDocument(view.editor!)).toBe("@Same#1234 before  after")
  })

  it("completes a pending selection when its canonical profile becomes ready", async () => {
    profiles.value = new Map()
    const base = props()
    let renderer!: ReturnType<typeof render>
    await act(async () => { renderer = render(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual([])
    profiles.value = new Map([["author", { id: "author", name: "Same", discriminator: "1234" }]])
    await act(async () => { renderer.rerender(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual(["author"])
  })

  it("restores first, inserts once, persists the atom and does not reinsert after deletion or send", async () => {
    writeComposerDraft("viewer:dm-reply", doc(paragraph(text("draft"))))
    const accept = vi.fn(() => true)
    const base = props(accept)
    let renderer!: ReturnType<typeof render>
    await act(async () => { renderer = render(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(view.editor).not.toBeNull()
    expect(serializeComposerDocument(view.editor!)).toBe("@Same#1234 draft")
    expect(readComposerDraft("viewer:dm-reply")).toEqual(view.editor!.getJSON())
    expect(renderer.container.querySelector("[data-type=mention]")?.textContent).toBe("@Same")
    await act(async () => { view.editor!.commands.deleteRange({ from: 1, to: 2 }) })
    profiles.value = new Map(profiles.value)
    await act(async () => { renderer.rerender(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual([])
    await act(async () => { view.onSend() })
    expect(accept).toHaveBeenCalledWith("draft", undefined, undefined)
    expect(view.editor!.isEmpty).toBe(true)
    expect(readComposerDraft("viewer:dm-reply")).toBeNull()
  })

  it("waits for a canonical identity, cancels safely, and reuses after reselection", async () => {
    profiles.value = new Map()
    const base = props()
    let renderer!: ReturnType<typeof render>
    await act(async () => { renderer = render(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual([])
    profiles.value = new Map([["author", { id: "author", name: "Same", discriminator: "1234" }]])
    await act(async () => { renderer.rerender(createElement(Harness, base)) })
    expect(mentionIds(view.editor!)).toEqual([])
    await act(async () => { renderer.rerender(createElement(Harness, { ...base, replyingTo: reply })) })
    expect(mentionIds(view.editor!)).toEqual(["author"])
    await act(async () => { renderer.rerender(createElement(Harness, base)) })
    expect(mentionIds(view.editor!)).toEqual(["author"])
    await act(async () => { renderer.rerender(createElement(Harness, { ...base, replyingTo: { ...reply, text: "another message" } })) })
    expect(mentionIds(view.editor!)).toEqual(["author"])
  })

  it("keeps the visible body and attachment on rejection and sends the same body again", async () => {
    const accept = vi.fn(() => false)
    const base = props(accept)
    const handle = createRef<ComposerHandle>()
    await act(async () => { render(createElement(Harness, { ...base, replyingTo: reply, ref: handle })) })
    const file = new File(["draft attachment"], "draft.txt", { type: "text/plain" })
    await act(async () => { view.onFileSelect({ target: { files: [file], value: "" } } as never) })
    expect(view.pendingFiles).toHaveLength(1)
    const before = view.editor!.getJSON()
    await act(async () => { handle.current!.submitNow() })
    expect(view.editor!.getJSON()).toEqual(before)
    expect(view.pendingFiles).toHaveLength(1)
    expect(accept.mock.calls[0]?.[0]).toBe("@Same#1234")
    accept.mockReturnValue(true)
    await act(async () => { handle.current!.submitNow() })
    expect(accept.mock.calls[1]).toEqual(accept.mock.calls[0])
    expect(view.editor!.isEmpty).toBe(true)
    expect(view.pendingFiles).toHaveLength(0)
  })
})
