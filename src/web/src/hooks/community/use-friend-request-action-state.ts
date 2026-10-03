"use client"

import { useCallback } from "react"
import { useMutationState, useQueryClient } from "@tanstack/react-query"
import { isAbortError } from "@/lib/errors"

export type FriendRequestAction = "accept" | "reject"
export type FriendRequestSurface = "inbox" | "friends"
type FriendRequestRow = { id: string; userId?: string }
export type ActionableFriendRequest<T> = { row: T; action?: FriendRequestAction; status?: "pending" | "error"; error?: string }
const key = ["community", "friend-request"] as const

export function useFriendRequestActionState<T extends FriendRequestRow>({ rows, onAccept, onReject, surface: _surface }: { rows: readonly T[]; onAccept?: (id: string) => Promise<unknown>; onReject?: (id: string) => Promise<unknown>; surface: FriendRequestSurface }) {
  const queryClient = useQueryClient()
  const commands = useMutationState({ filters: { mutationKey: key }, select: (mutation) => ({ id: (mutation.state.variables as { friendshipId?: string } | undefined)?.friendshipId, action: mutation.options.mutationKey?.[2] as FriendRequestAction, status: mutation.state.status, error: mutation.state.error, at: mutation.state.submittedAt, mutationId: mutation.mutationId }) })
  const items: Array<ActionableFriendRequest<T>> = rows.map((row) => {
    const command = commands.filter((entry) => entry.id === row.id).sort((a, b) => b.at - a.at || b.mutationId - a.mutationId)[0]
    if (!command || command.status === "success" || isAbortError(command.error)) return { row }
    const status = command.status === "pending" ? "pending" : command.status === "error" ? "error" : undefined
    return { row, action: command.action, status, ...(status === "error" ? { error: `Couldn’t ${command.action} this request. Try again.` } : {}) }
  })
  const run = useCallback((item: ActionableFriendRequest<T>, action: FriendRequestAction, retry: boolean) => {
    const pending = queryClient.getMutationCache().find({ mutationKey: key, exact: false, status: "pending", predicate: (mutation) => (mutation.state.variables as { friendshipId?: string } | undefined)?.friendshipId === item.row.id })
    if (pending) return pending.continue().then(() => undefined, () => undefined)
    if (retry && item.status !== "error") return Promise.resolve()
    const mutation = action === "accept" ? onAccept : onReject
    return mutation ? mutation(item.row.id).then(() => undefined, () => undefined) : Promise.resolve()
  }, [queryClient, onAccept, onReject])
  return { items, act: (item: ActionableFriendRequest<T>, action: FriendRequestAction) => run(item, action, false), retry: (item: ActionableFriendRequest<T>) => item.action ? run(item, item.action, true) : Promise.resolve() }
}
