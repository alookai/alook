import { OrderedList } from "@tiptap/extension-list"
import StarterKit from "@tiptap/starter-kit"
import {
  getText,
  getTextSerializersFromSchema,
  wrappingInputRule,
  type Editor,
} from "@tiptap/react"
import type { Node as ProseMirrorNode, NodeType, Slice } from "@tiptap/pm/model"
import type { EditorView } from "@tiptap/pm/view"

const POSITIVE_ORDERED_LIST_INPUT_REGEX = /^([1-9]\d*)\.\s$/

export function composerOrderedListInputRule(type: NodeType) {
  return wrappingInputRule({
    find: POSITIVE_ORDERED_LIST_INPUT_REGEX,
    type,
    getAttributes: (match) => ({ start: Number(match[1]) }),
    joinPredicate: (match, node) => {
      const hasDefaultType = !node.attrs.type || node.attrs.type === "1"
      return hasDefaultType && node.childCount + node.attrs.start === Number(match[1])
    },
  })
}

const ComposerOrderedList = OrderedList.extend({
  addInputRules() {
    return [composerOrderedListInputRule(this.type)]
  },
})

export function composerDocumentExtensions(isForumThreadBody: boolean) {
  return [
    StarterKit.configure({
      heading: false,
      horizontalRule: false,
      codeBlock: false,
      code: false,
      blockquote: false,
      bold: false,
      italic: false,
      strike: false,
      bulletList: false,
      orderedList: false,
      listItem: isForumThreadBody ? false : {},
      listKeymap: isForumThreadBody ? false : {},
      trailingNode: isForumThreadBody ? {} : false,
    }),
    ...(isForumThreadBody ? [] : [ComposerOrderedList]),
  ]
}

export function preserveComposerPlainTextPaste(
  view: EditorView,
  text: string | undefined,
  html: string | undefined,
  slice: Slice,
): boolean {
  if (!text || html) return false
  view.dispatch(
    view.state.tr
      .replaceSelection(slice)
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  )
  return true
}

type TextSerializers = ReturnType<typeof getTextSerializersFromSchema>

function indentContinuationLines(text: string, indent: number): string {
  return text.replaceAll("\n", `\n${" ".repeat(indent)}`)
}

function indentEveryLine(text: string, indent: number): string {
  const prefix = " ".repeat(indent)
  return `${prefix}${indentContinuationLines(text, indent)}`
}

function serializeTextBlock(
  node: ProseMirrorNode,
  serializers: TextSerializers,
): string {
  return getText(node, {
    blockSeparator: "\n\n",
    textSerializers: serializers,
  })
}

function orderedListStart(node: ProseMirrorNode): number {
  return typeof node.attrs.start === "number" ? node.attrs.start : 1
}

function serializeListItem(
  node: ProseMirrorNode,
  number: number,
  baseIndent: number,
  serializers: TextSerializers,
): string {
  const marker = `${number}. `
  const contentIndent = baseIndent + marker.length
  let text = `${" ".repeat(baseIndent)}${marker}`
  let hasBlock = false

  node.forEach((child) => {
    if (child.type.name === "orderedList") {
      text += `\n${serializeOrderedList(child, contentIndent, serializers)}`
      hasBlock = true
      return
    }

    const block = serializeTextBlock(child, serializers)
    if (!hasBlock) {
      text += indentContinuationLines(block, contentIndent)
    } else {
      text += `\n\n${indentEveryLine(block, contentIndent)}`
    }
    hasBlock = true
  })

  return text
}

function serializeOrderedList(
  node: ProseMirrorNode,
  baseIndent: number,
  serializers: TextSerializers,
): string {
  const items: string[] = []
  const start = orderedListStart(node)
  node.forEach((item, _offset, index) => {
    items.push(serializeListItem(item, start + index, baseIndent, serializers))
  })
  return items.join("\n")
}

export function serializeComposerDocument(editor: Editor): string {
  const serializers = getTextSerializersFromSchema(editor.schema)
  const blocks: string[] = []
  editor.state.doc.forEach((node) => {
    blocks.push(
      node.type.name === "orderedList"
        ? serializeOrderedList(node, 0, serializers)
        : serializeTextBlock(node, serializers),
    )
  })
  return blocks.join("\n\n")
}
