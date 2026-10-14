import type { Editor } from "@tiptap/react"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { closeHistory } from "@tiptap/pm/history"
import type { ComposerMention } from "./composer-types"

export function prependReplyMention(
  editor: Editor,
  mention: ComposerMention,
  identityIds: readonly string[] = [mention.id],
  resolveUserId?: (id: string) => string | undefined,
): void {
  const { state } = editor
  let existing: { node: ProseMirrorNode; position: number } | undefined
  state.doc.descendants((node, position) => {
    if (existing) return false
    if (node.type.name !== "mention") return
    const userId = resolveUserId?.(node.attrs.id)
    const matches = userId !== undefined
      ? userId === mention.id
      : identityIds.includes(node.attrs.id) || node.attrs.label === mention.label
    if (matches) {
      existing = { node, position }
      return false
    }
  })
  if (existing?.position === 1 && state.doc.firstChild?.type.name === "paragraph") return

  const transaction = closeHistory(state.tr)
  const node = existing?.node ?? state.schema.nodes.mention.create(mention)
  if (existing) transaction.delete(existing.position, existing.position + node.nodeSize)
  const first = transaction.doc.firstChild
  const separator = state.schema.text(" ")
  if (first?.type.name === "paragraph") {
    const needsSeparator = !first.firstChild?.isText || !/^\s/u.test(first.firstChild.text ?? "")
    transaction.insert(1, needsSeparator ? [node, separator] : node)
  } else {
    transaction.insert(0, state.schema.nodes.paragraph.create(null, [node, separator]))
  }
  editor.view.dispatch(transaction)
}
