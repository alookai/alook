import { unified, type PluggableList } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import type { Root } from "mdast"
import { formatHandle, type MentionCandidate, type MentionType } from "@alook/shared"
import { cjk } from "@streamdown/cjk"
import remarkMath from "remark-math"
import { chatSyntaxPlugin, type MentionNode } from "./chat-syntax-plugin"

export const CHAT_REMARK_PLUGINS: PluggableList = [remarkGfm, chatSyntaxPlugin, remarkBreaks]

const processor = unified()
  .use(remarkParse)
  .use(cjk.remarkPluginsBefore)
  .use(CHAT_REMARK_PLUGINS)
  .use(cjk.remarkPluginsAfter)
  .use(remarkMath, { singleDollarTextMath: true })
  .freeze()

function parsedMentions(content: string): MentionNode[] {
  if (!content.includes("@")) return []
  const tree = processor.runSync(processor.parse(content)) as Root
  const mentions: MentionNode[] = []
  function visit(node: { type: string; children?: unknown[] }): void {
    if (node.type === "mention") mentions.push(node as MentionNode)
    if (node.children) {
      for (const child of node.children) visit(child as Parameters<typeof visit>[0])
    }
  }
  visit(tree)
  return mentions
}

export function detectChatMentionType(content: string): MentionType | undefined {
  return parsedMentions(content).some((node) => node.everyone) ? "everyone" : undefined
}

export function extractChatMentionedUserIds(content: string, candidates: MentionCandidate[]): string[] {
  const byHandle = new Map<string, string>()
  for (const candidate of candidates) {
    if (!candidate.name || !candidate.discriminator) continue
    const handle = `@${formatHandle(candidate.name, candidate.discriminator)}`.toLowerCase()
    if (!byHandle.has(handle)) byHandle.set(handle, candidate.userId)
  }
  const found = new Set<string>()
  for (const node of parsedMentions(content)) {
    if (node.everyone || !node.discriminator) continue
    const userId = byHandle.get(`${node.value}#${node.discriminator}`.toLowerCase())
    if (userId) found.add(userId)
  }
  return [...found]
}
