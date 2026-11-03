import type { Root } from "mdast"
import type { CommunityMessageResource } from "../community-resources"
import { truncateMessagePreview } from "../constants/community"
import { chatMarkdownProcessor } from "./chat-markdown"
import { replaceHtmlPreviewMarkers, type HtmlPreviewAttachment } from "./html-preview"
import { REDACTED } from "./redaction"

export type MessagePreviewInput = Partial<Pick<CommunityMessageResource,
  "content" | "type" | "systemKind" | "embeds"
>> & { attachments?: readonly HtmlPreviewAttachment[]; approval?: Pick<NonNullable<CommunityMessageResource["approval"]>, "friendshipId">; botCreation?: Pick<NonNullable<CommunityMessageResource["botCreation"]>, "requestId"> }

type TextNode = {
  type: string
  value?: string
  alt?: string | null
  lang?: string | null
  discriminator?: string
  children?: TextNode[]
}

function readableNode(node: TextNode): string {
  const children = () => (node.children ?? []).map(readableNode)
  switch (node.type) {
    case "spoiler": return "[Spoiler]"
    case "htmlPreview": return "HTML preview"
    case "image":
    case "imageReference": return node.alt ? `Photo: ${node.alt}` : "Photo"
    case "mention": return `${node.value ?? ""}${node.discriminator ? `#${node.discriminator}` : ""}`
    case "code": return node.lang?.toLowerCase() === "mermaid" ? "Diagram" : `Code: ${node.value ?? ""}`
    case "math":
    case "inlineMath": return `Math: ${node.value ?? ""}`
    case "break": return " "
    case "thematicBreak": return " "
    case "definition":
    case "footnoteDefinition": return ""
    case "root":
    case "blockquote":
    case "list":
    case "listItem":
    case "table":
    case "tableRow": return children().join(" ")
    default: return node.children ? children().join("") : node.value ?? ""
  }
}

function attachmentText(attachment: HtmlPreviewAttachment): string {
  const type = attachment.contentType?.toLowerCase() ?? ""
  const label = type.startsWith("image/") ? "Photo" : type.startsWith("video/") ? "Video" : type.startsWith("audio/") ? "Audio" : "Attachment"
  return attachment.name ? `${label}: ${attachment.name}` : label
}

export function messagePreviewText(message: MessagePreviewInput): string {
  if (message.approval) return "Friend request"
  if (message.botCreation) return "Bot creation request"
  const content = message.content ?? ""
  const tree = chatMarkdownProcessor.runSync(chatMarkdownProcessor.parse(content)) as Root
  const selected = replaceHtmlPreviewMarkers(tree, { text: content, attachments: message.attachments })
  const text = readableNode(tree as TextNode)
  const attachments = (message.attachments ?? []).filter((attachment) => !attachment.id || !selected.has(attachment.id)).map(attachmentText)
  const embeds = !text.trim() ? (message.embeds ?? []).flatMap((embed) => {
    if (!embed || typeof embed !== "object" || !("title" in embed) || typeof embed.title !== "string") return []
    return [embed.title]
  }) : []
  const result = [text, ...attachments, ...embeds].join(" ").replace(REDACTED, "[redacted]").replace(/\s+/gu, " ").trim()
  return result || (message.systemKind === "thread" ? "Thread created" : "")
}

export function messagePreview(message: MessagePreviewInput): string {
  return truncateMessagePreview(messagePreviewText(message))
}
