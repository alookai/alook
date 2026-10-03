"use client"

import type { Transaction } from "@tanstack/react-db"
import { createStore } from "@tanstack/store"
import { useCallback } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { beginCommunityCommandRevision, publishCommunityMessageReaction, type CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { isAbortError } from "@/lib/errors"
import type { Msg } from "@/lib/community/models/message"
import { useCommunityMutationOrigin } from "../community-origin"
import type { ReactionArgs } from "./message-command-inputs"

const key = ["community", "message-reaction"] as const
type ReactionProtocol = { requestStarted: boolean; transaction: Transaction<Record<string, unknown>> | null }
type Intent = ReactionArgs & { token: CommunityLiveSnapshotToken; originalMe: boolean; nextMe: boolean; readyAt: number; protocol: ReturnType<typeof createStore<ReactionProtocol>> }
function same(a: Intent, b: ReactionArgs) { return a.messageId === b.messageId && a.emoji === b.emoji && a.userId === b.userId }
function reactions(source: Msg["reactions"], args: Intent) {
  const rows = (source ?? []).map((row) => ({ ...row, userIds: [...row.userIds] }))
  const row = rows.find((candidate) => candidate.emoji === args.emoji)
  if (args.nextMe) { if (row && !row.userIds.includes(args.userId)) row.userIds.push(args.userId); else if (!row) rows.push({ emoji: args.emoji, count: 1, me: true, userIds: [args.userId] }) }
  else if (row) row.userIds = row.userIds.filter((id) => id !== args.userId)
  return rows.filter((row) => row.userIds.length).map((row) => ({ ...row, count: row.userIds.length, me: row.userIds.includes(args.userId) }))
}

function useReactionIntent(intent: "toggle" | "add") {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const assert = (args: Intent) => { origin.assert(args.token); args.assertActive?.() }
  const pending = useCallback((args: ReactionArgs) => queryClient.getMutationCache().findAll({ mutationKey: key, status: "pending", predicate: (mutation) => same(mutation.state.variables as Intent, args) }).map((mutation) => mutation.state.variables as Intent), [queryClient])
  const mutation = useMutation<void, Error, Intent>({
    mutationKey: key, scope: { id: "community-reaction-commands" }, gcTime: 0,
    onMutate: async (args) => {
      await origin.registry?.ready
      assert(args)
      await origin.registry!.collections.messages.preload()
      assert(args)
      const persist = async () => {
        const delay = Math.max(0, args.readyAt - Date.now())
        if (delay) await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); args.assertActive?.signal.removeEventListener("abort", abort); subscription.unsubscribe() }
          const abort = () => { cleanup(); reject(new DOMException("Retired reaction", "AbortError")) }
          const timer = setTimeout(() => { cleanup(); resolve() }, delay)
          const subscription = origin.registry!.runtime.lifecycle.subscribe(() => { try { assert(args) } catch { abort() } })
          args.assertActive?.signal.addEventListener("abort", abort, { once: true })
          try { assert(args) } catch { abort() }
        })
        assert(args)
        if (pending(args).at(-1) !== args || args.nextMe === args.originalMe) return
        args.protocol.setState((state) => ({ ...state, requestStarted: true }))
        const proof = beginCommunityCommandRevision(queryClient, args.token)
        await origin.request(args.token, `/api/community/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}`, { method: args.nextMe ? "PUT" : "DELETE", signal: args.assertActive?.signal, assertActive: args.assertActive })
        assert(args)
        publishCommunityMessageReaction(queryClient, args.messageId, args.emoji, args.userId, args.nextMe, { token: proof, signal: args.assertActive?.signal })
      }
      const transaction = origin.registry!.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      args.protocol.setState((state) => ({ ...state, transaction }))
      transaction.mutate(() => { if (origin.registry!.collections.messages.has(args.messageId)) origin.registry!.collections.messages.update(args.messageId, (row) => { row.reactions = reactions(row.reactions as Msg["reactions"], args) }) })
      return { persist }
    },
    mutationFn: async (args, _context) => {
      assert(args)
      const transaction = args.protocol.get().transaction
      if (transaction?.mutations.length) await transaction.commit()
      else {
        const delay = Math.max(0, args.readyAt - Date.now())
        if (delay) await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); args.assertActive?.signal.removeEventListener("abort", abort); subscription.unsubscribe() }
          const abort = () => { cleanup(); reject(new DOMException("Retired reaction", "AbortError")) }
          const timer = setTimeout(() => { cleanup(); resolve() }, delay)
          const subscription = origin.registry!.runtime.lifecycle.subscribe(() => { try { assert(args) } catch { abort() } })
          args.assertActive?.signal.addEventListener("abort", abort, { once: true })
          try { assert(args) } catch { abort() }
        })
        assert(args)
        if (pending(args).at(-1) !== args || args.nextMe === args.originalMe) return
        args.protocol.setState((state) => ({ ...state, requestStarted: true }))
        const proof = beginCommunityCommandRevision(queryClient, args.token)
        await origin.request(args.token, `/api/community/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}`, { method: args.nextMe ? "PUT" : "DELETE", signal: args.assertActive?.signal, assertActive: args.assertActive })
        assert(args)
        publishCommunityMessageReaction(queryClient, args.messageId, args.emoji, args.userId, args.nextMe, { token: proof, signal: args.assertActive?.signal })
      }
      assert(args)
    },
    onError: (error, args) => { if (isAbortError(error)) return; try { assert(args) } catch { return } args.onError?.(error) },
  })
  const mutateReaction = mutation.mutate
  return useCallback((args: ReactionArgs) => {
    args.assertActive?.()
    const queued = pending(args), last = queued.at(-1)
    const source = origin.registry?.collections.messages.get(args.messageId)
    const wasMe = last?.nextMe ?? args.currentMe ?? ((source?.reactions as Msg["reactions"])?.find((row) => row.emoji === args.emoji)?.me ?? false)
    if (intent === "add" && wasMe) return
    const first = queued.find((command) => !command.protocol.get().requestStarted)
    const originalMe = first?.originalMe ?? (last?.protocol.get().requestStarted ? last.nextMe : wasMe)
    mutateReaction({ ...args, token: origin.begin().token, originalMe, nextMe: intent === "add" || !wasMe, readyAt: Date.now() + 300, protocol: createStore<ReactionProtocol>({ requestStarted: false, transaction: null }) })
  }, [intent, mutateReaction, origin, pending])
}

export function useToggleReactionApi() { return useReactionIntent("toggle") }
export function useAddReactionApi() { return useReactionIntent("add") }
