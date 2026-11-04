import { unified } from "unified"
import remarkParse from "remark-parse"
import type { Root, RootContent, Paragraph, Link } from "mdast"
import type { CommunityMessageAttachment } from "../community-resources"
import { CHAT_REMARK_PLUGINS } from "./chat-markdown"

export const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024

export function isHtmlPreviewFile(name: string, contentType?: string | null): boolean {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return type === "text/html" || (["", "application/octet-stream", "binary/octet-stream"].includes(type) && /\.html?$/i.test(name))
}

export type HtmlPreviewAttachment = Pick<CommunityMessageAttachment, "name"> & Partial<Pick<CommunityMessageAttachment, "id" | "contentType" | "sizeBytes">>

interface HtmlPreviewNode {
  type: "htmlPreview"
  data: { hName: "htmlpreview"; hProperties: { dataAttachmentId: string } }
}

declare module "mdast" {
  interface RootContentMap { htmlPreview: HtmlPreviewNode }
}

type Options<T extends HtmlPreviewAttachment = HtmlPreviewAttachment> = { text: string; attachments?: readonly T[] }
const parser = unified().use(remarkParse).use(CHAT_REMARK_PLUGINS).freeze()

export function replaceHtmlPreviewMarkers<T extends HtmlPreviewAttachment>(tree: Root, { text, attachments }: Options<T>): Map<string, T> {
  const files = new Map((attachments ?? []).flatMap((attachment) => attachment.id
    && isHtmlPreviewFile(attachment.name, attachment.contentType)
    && (attachment.sizeBytes == null || attachment.sizeBytes <= MAX_HTML_PREVIEW_BYTES)
    ? [[attachment.id, attachment] as const] : []))
  const selected = new Map<string, T>()
  if (!files.size || !text.includes("[alook-html-preview]")) return selected

  function attachmentFor(node: Paragraph["children"][number]): T | undefined {
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

export function selectHtmlPreviews<T extends HtmlPreviewAttachment>(text: string, attachments?: readonly T[]): Map<string, T> {
  if (!attachments?.some((attachment) => attachment.id) || !text.includes("[alook-html-preview]")) return new Map()
  const tree = parser.runSync(parser.parse(text)) as Root
  return replaceHtmlPreviewMarkers(tree, { text, attachments })
}

