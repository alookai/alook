"use client"

import { useCallback, useMemo } from "react"
import { useMutationState, useQueryClient } from "@tanstack/react-query"
import { isAbortError } from "@/lib/errors"

export type FriendRequestAction = "accept" | "reject"
type FriendRequestRow = { id: string; userId?: string }
export type ActionableFriendRequest<T> = { row: T; action?: FriendRequestAction; status?: "pending" | "error"; error?: string }
const key = ["community", "friend-request"] as const

export function useFriendRequestActionState<T extends FriendRequestRow>({ rows, onAccept, onReject }: { rows: readonly T[]; onAccept?: (id: string) => Promise<unknown>; onReject?: (id: string) => Promise<unknown> }) {
  const queryClient = useQueryClient()
  const commands = useMutationState({ filters: { mutationKey: key }, select: (mutation) => ({ id: (mutation.state.variables as { friendshipId?: string } | undefined)?.friendshipId, action: mutation.options.mutationKey?.[2] as FriendRequestAction, status: mutation.state.status, error: mutation.state.error, at: mutation.state.submittedAt, mutationId: mutation.mutationId }) })
  const items = useMemo<Array<ActionableFriendRequest<T>>>(() => {
    const latestById = new Map<string, (typeof commands)[number]>()
    for (const entry of commands) {
      if (!entry.id) continue
      const existing = latestById.get(entry.id)
      if (!existing || entry.at > existing.at || (entry.at === existing.at && entry.mutationId > existing.mutationId)) {
        latestById.set(entry.id, entry)
      }
    }
    return rows.map((row) => {
      const command = latestById.get(row.id)
      if (!command || command.status === "success" || isAbortError(command.error)) return { row }
      const status = command.status === "pending" ? "pending" : command.status === "error" ? "error" : undefined
      return { row, action: command.action, status, ...(status === "error" ? { error: `Couldn’t ${command.action} this request. Try again.` } : {}) }
    })
  }, [commands, rows])
  const run = useCallback((item: ActionableFriendRequest<T>, action: FriendRequestAction, retry: boolean) => {
    const pending = queryClient.getMutationCache().find({ mutationKey: key, exact: false, status: "pending", predicate: (mutation) => (mutation.state.variables as { friendshipId?: string } | undefined)?.friendshipId === item.row.id })
    if (pending) return pending.continue().then(() => undefined, () => undefined)
    if (retry && item.status !== "error") return Promise.resolve()
    const mutation = action === "accept" ? onAccept : onReject
    return mutation ? mutation(item.row.id).then(() => undefined, () => undefined) : Promise.resolve()
  }, [queryClient, onAccept, onReject])
  const act = useCallback((item: ActionableFriendRequest<T>, action: FriendRequestAction) => run(item, action, false), [run])
  const retry = useCallback((item: ActionableFriendRequest<T>) => item.action ? run(item, item.action, true) : Promise.resolve(), [run])
  return useMemo(() => ({ items, act, retry }), [act, items, retry])
}
