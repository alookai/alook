import { replaceEqualDeep } from "@tanstack/react-query"
import type { ChatMessagesData } from "./chat-cache"

export function reconcileChatMessages(previous: unknown, incoming: unknown): ChatMessagesData {
  const old = previous as ChatMessagesData | undefined
  const next = incoming as ChatMessagesData
  const revisions = next.pages.flatMap((page) => page.requestRevision === undefined ? [] : [page.requestRevision])
  if (!revisions.length) return replaceEqualDeep(old, next)
  const started = Math.min(...revisions)
  const live = (old?.pages ?? []).flatMap((page) => page.messages).filter((row) => (old?.liveMessageRevisions?.[row.id] ?? 0) > started)
  const liveIds = new Set(live.map((row) => row.id))
  const pages = next.pages.map(({ requestRevision: _, ...page }, index) => ({
    ...page,
    messages: [...page.messages.filter((row) => !liveIds.has(row.id)), ...(!index ? live : [])].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
  }))
  return replaceEqualDeep(old, { ...next, pages, serverMessageCount: old?.serverMessageCount ?? 0, liveRevision: old?.liveRevision ?? 0, liveMessageRevisions: old?.liveMessageRevisions ?? {} })
}
