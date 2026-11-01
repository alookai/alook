import { unified, type Plugin } from "unified"
import remarkParse from "remark-parse"
import type { Root, RootContent, Paragraph, Link } from "mdast"
import type { Attachment, FileAttachment } from "./models/message"
import { CHAT_REMARK_PLUGINS } from "./chat-markdown"

import { isHtmlPreviewFile, MAX_HTML_PREVIEW_BYTES } from "./html-preview-policy"

interface HtmlPreviewNode {
  type: "htmlPreview"
  data: { hName: "htmlpreview"; hProperties: { dataAttachmentId: string } }
}

declare module "mdast" {
  interface RootContentMap { htmlPreview: HtmlPreviewNode }
}

type Options = { text: string; attachments?: readonly Attachment[] }
const parser = unified().use(remarkParse).use(CHAT_REMARK_PLUGINS).freeze()

function replaceMarkers(tree: Root, { text, attachments }: Options): Map<string, FileAttachment> {
  const files = new Map((attachments ?? []).flatMap((attachment) => attachment.kind === "file" && attachment.id
    && isHtmlPreviewFile(attachment.name, attachment.contentType)
    && (attachment.sizeBytes === undefined || attachment.sizeBytes <= MAX_HTML_PREVIEW_BYTES)
    ? [[attachment.id, attachment] as const] : []))
  const selected = new Map<string, FileAttachment>()
  if (!files.size || !text.includes("[alook-html-preview]")) return selected

  function attachmentFor(node: Paragraph["children"][number]): FileAttachment | undefined {
    if (node.type !== "link") return
    const link: Link = node
    const start = link.position?.start.offset, end = link.position?.end.offset
    if (start === undefined || end === undefined || link.title
      || link.children.length !== 1 || link.children[0]?.type !== "text" || link.children[0].value !== "alook-html-preview"
      || text.slice(start, end) !== `[alook-html-preview](${link.url})`
      || (start > 0 && !/\s/.test(text[start - 1]!))
      || (end < text.length && !/\s/.test(text[end]!))) return
    return files.get(link.url)
  }

  function walk(parent: { children: RootContent[] }) {
    parent.children = parent.children.flatMap((node): RootContent[] => {
      if (node.type === "blockquote" || node.type === "listItem" || node.type === "list") {
        walk(node)
        return [node]
      }
      if (node.type !== "paragraph") return [node]
      const blocks: RootContent[] = []
      let children: Paragraph["children"] = []
      function flush() {
        if (children.some((child) => child.type !== "text" || child.value.trim())) blocks.push({ type: "paragraph", children })
        children = []
      }
      for (const child of node.children) {
        const attachment = attachmentFor(child)
        if (!attachment?.id) { children.push(child); continue }
        flush()
        if (!selected.has(attachment.id)) {
          selected.set(attachment.id, attachment)
          blocks.push({ type: "htmlPreview", data: { hName: "htmlpreview", hProperties: { dataAttachmentId: attachment.id } } })
        }
      }
      if (!blocks.length && children.length === node.children.length) return [node]
      flush()
      return blocks
    })
  }
  walk(tree)
  return selected
}

export function selectHtmlPreviews(text: string, attachments?: readonly Attachment[]): Map<string, FileAttachment> {
  if (!attachments?.some((attachment) => attachment.id) || !text.includes("[alook-html-preview]")) return new Map()
  const tree = parser.runSync(parser.parse(text)) as Root
  return replaceMarkers(tree, { text, attachments })
}

export const htmlPreviewPlugin: Plugin<[Options], Root> = (options) => (tree) => { replaceMarkers(tree, options) }
