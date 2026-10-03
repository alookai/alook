import { replaceEqualDeep } from "@tanstack/react-query"

export type ChatFlagsData = { ids: string[]; revision?: number; writes?: Record<string, { flagged: boolean; revision: number }>; requestRevision?: number }
export function reconcileChatFlags(previous: unknown, incoming: unknown): unknown {
  const next = incoming as ChatFlagsData | undefined
  const old = previous as ChatFlagsData | undefined
  if (next?.requestRevision === undefined) return replaceEqualDeep(previous, incoming)
  const { requestRevision, ...data } = next
  const ids = new Set(data.ids)
  const writes: NonNullable<ChatFlagsData["writes"]> = {}
  for (const [id, write] of Object.entries(old?.writes ?? {})) {
    if (write.revision <= requestRevision) continue
    if (write.flagged) ids.add(id); else ids.delete(id)
    writes[id] = write
  }
  return replaceEqualDeep(previous, { ...data, ids: [...ids], revision: old?.revision ?? 0, writes })
}
