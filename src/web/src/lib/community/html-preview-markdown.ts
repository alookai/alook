import type { Plugin } from "unified"
import type { Root } from "mdast"
import { replaceHtmlPreviewMarkers, selectHtmlPreviews as select } from "@alook/shared/html-preview"
import type { Attachment, FileAttachment } from "./models/message"

type Options = { text: string; attachments?: readonly Attachment[] }
const files = (attachments?: readonly Attachment[]): FileAttachment[] => (attachments ?? []).filter((file): file is FileAttachment => file.kind === "file")
export function selectHtmlPreviews(text: string, attachments?: readonly Attachment[]): Map<string, FileAttachment> {
  return select(text, files(attachments))
}
export const htmlPreviewPlugin: Plugin<[Options], Root> = (options) => (tree) => {
  replaceHtmlPreviewMarkers(tree, { text: options.text, attachments: files(options.attachments) })
}
