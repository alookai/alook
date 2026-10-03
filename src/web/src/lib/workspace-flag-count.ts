import { replaceEqualDeep } from "@tanstack/react-query"
import type { WorkspaceOwner } from "@/contexts/workspace-context"

export type FlagCountData = { count: number; confirmedCount?: number; revision?: number; pending?: Record<string, { delta: number; revision: number }>; requestRevision?: number }
const visibleCount = (confirmed: number, pending: NonNullable<FlagCountData["pending"]>) => Math.max(0, confirmed + Object.values(pending).reduce((sum, write) => sum + write.delta, 0))
export function reconcileFlagCount(previous: unknown, incoming: unknown): unknown {
  const next = incoming as FlagCountData | undefined
  const old = previous as FlagCountData | undefined
  if (next?.requestRevision === undefined) return replaceEqualDeep(previous, incoming)
  const pending = Object.fromEntries(Object.entries(old?.pending ?? {}).filter(([, write]) => write.revision > next.requestRevision!))
  return replaceEqualDeep(previous, { count: visibleCount(next.count, pending), confirmedCount: next.count, revision: old?.revision ?? 0, pending })
}
export function beginFlagCountWrite(owner: WorkspaceOwner, delta: number) {
  let ticket = ""
  owner.queryClient.setQueryData<FlagCountData>(owner.key("flag-count"), (previous) => {
    const revision = (previous?.revision ?? 0) + 1
    ticket = String(revision)
    const pending = { ...previous?.pending, [ticket]: { delta, revision } }
    const confirmedCount = previous?.confirmedCount ?? previous?.count ?? 0
    return { confirmedCount, revision, pending, count: visibleCount(confirmedCount, pending) }
  })
  return { ticket, query: owner.queryClient.getQueryCache().find({ queryKey: owner.key("flag-count"), exact: true }) }
}
export function rollbackFlagCountWrite(owner: WorkspaceOwner, write: ReturnType<typeof beginFlagCountWrite>) {
  const current = owner.queryClient.getQueryCache().find({ queryKey: owner.key("flag-count"), exact: true })
  if (!write.query || current !== write.query) return
  const ticket = write.ticket
  owner.queryClient.setQueryData<FlagCountData>(owner.key("flag-count"), (previous) => {
    if (!previous?.pending?.[ticket]) return previous
    const { [ticket]: _removed, ...pending } = previous.pending
    const confirmedCount = previous.confirmedCount ?? previous.count
    return { ...previous, pending, count: visibleCount(confirmedCount, pending) }
  })
}
