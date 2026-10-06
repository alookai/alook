"use client"

import { useMutation, useQueryClient, type Query, type MutateOptions } from "@tanstack/react-query"
import { useCallback } from "react"
import type { CommunityRole } from "@alook/shared"
import { useCommunityMutationOrigin } from "../community-origin"
import { communityKeys } from "@/lib/query-keys"
import { beginCommunityCommandRevision, publishCommunityMemberRole, publishCommunityMemberRemoval } from "@/lib/community-db/sync"
import { serverMembershipSchema } from "@/lib/community-db/schema"
import { patchMemberKickWindows } from "../use-server-members"

type MemberView = (() => void) & { signal: AbortSignal }
export type SetMemberRoleArgs = { serverId: string; memberId: string; role: CommunityRole; assertActive?: MemberView }
export type KickMemberArgs = { serverId: string; memberId: string; assertActive?: MemberView }

function useMemberCommand<TInput extends KickMemberArgs>(kind: "role" | "kick") {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  type Intent = { kind: typeof kind; input: SetMemberRoleArgs | KickMemberArgs; original: ReturnType<typeof origin.begin>["token"]; resources: Query[] }
  const native = useMutation({ meta: { observabilityAction: "server.member.command" },
    mutationKey: ["community", "member-command"], scope: { id: "community-member-command" }, gcTime: 0,
    mutationFn: async ({ kind, input, original, resources }: Intent) => {
      origin.assert(original)
      input.assertActive?.()
      const registry = origin.registry!
      await registry.ready
      origin.assert(original)
      await registry.collections.serverMemberships.preload()
      origin.assert(original)
      const root = communityKeys.members(input.serverId)
      await queryClient.cancelQueries({ queryKey: root, predicate: (query) => resources.includes(query) })
      origin.assert(original)
      input.assertActive?.()
      const proof = beginCommunityCommandRevision(queryClient, original)
      const committed = () => queryClient.getQueryData<ReturnType<typeof serverMembershipSchema.parse>[]>(communityKeys.communityDbCollection(registry.scopeId, "serverMemberships")) ?? [...registry.collections.serverMemberships.values()]
      const row = committed().find((row) => row.serverId === input.serverId && row.memberId === input.memberId)
      const memberKey = row?.id
      const persist = async () => {
        await origin.request(original, "/api/community/servers/" + input.serverId + "/members/" + input.memberId, { method: kind === "role" ? "PATCH" : "DELETE", signal: input.assertActive?.signal, assertActive: input.assertActive, ...(kind === "role" ? { body: JSON.stringify({ role: (input as SetMemberRoleArgs).role }) } : {}) })
        origin.assert(original)
        if (kind === "role") {
          if (memberKey) publishCommunityMemberRole(queryClient, memberKey, input.memberId, (input as SetMemberRoleArgs).role, { token: proof, signal: input.assertActive?.signal })
        } else {
          const current = memberKey ? committed().find((row) => row.id === memberKey) : undefined
          if (!memberKey || current?.memberId === input.memberId) {
            if (memberKey) publishCommunityMemberRemoval(queryClient, memberKey, input.memberId, { token: proof, signal: input.assertActive?.signal })
            patchMemberKickWindows(queryClient, resources, input.memberId)
          }
        }
      }
      const invalidateOriginal = () => {
        try { origin.assert(original) } catch { return }
        for (const resource of resources) {
          if (queryClient.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) void queryClient.invalidateQueries({ queryKey: resource.queryKey, exact: true }, { cancelRefetch: false })
        }
      }
      try {
      if (memberKey && registry.collections.serverMemberships.get(memberKey)?.memberId === input.memberId) {
        const transaction = registry.dbClient.createTransaction({ mutationFn: persist })
        transaction.mutate(() => {
          if (kind === "role") registry.collections.serverMemberships.update(memberKey, (row) => { row.role = (input as SetMemberRoleArgs).role })
          else registry.collections.serverMemberships.delete(memberKey)
        })
        try { await transaction.when("settled") } catch (error) { origin.assert(original); throw error }
      } else await persist()
      origin.assert(original)
      } finally { invalidateOriginal() }
    },
  })
  const capture = useCallback((input: TInput): Intent => { input.assertActive?.(); return { kind, input, original: origin.begin().token, resources: queryClient.getQueryCache().findAll({ queryKey: communityKeys.members(input.serverId) }) } }, [kind, origin, queryClient])
  const qualify = useCallback((callbacks?: MutateOptions<void, Error, TInput, unknown>): MutateOptions<void, Error, Intent, unknown> | undefined => callbacks && ({
    onSuccess: (data, args, result, context) => { try { origin.assert(args.original); args.input.assertActive?.() } catch { return } callbacks.onSuccess?.(data, args.input as TInput, result, context) },
    onError: (error, args, result, context) => { try { origin.assert(args.original); args.input.assertActive?.() } catch { return } callbacks.onError?.(error, args.input as TInput, result, context) },
    onSettled: (data, error, args, result, context) => { try { origin.assert(args.original); args.input.assertActive?.() } catch { return } callbacks.onSettled?.(data, error, args.input as TInput, result, context) },
  }), [origin])
  const nativeMutate = native.mutate, nativeMutateAsync = native.mutateAsync
  const mutate = useCallback((input: TInput, callbacks?: MutateOptions<void, Error, TInput, unknown>) => nativeMutate(capture(input), qualify(callbacks)), [nativeMutate, capture, qualify])
  const mutateAsync = useCallback((input: TInput, callbacks?: MutateOptions<void, Error, TInput, unknown>) => nativeMutateAsync(capture(input), qualify(callbacks)), [nativeMutateAsync, capture, qualify])
  return { ...native, mutate, mutateAsync }
}

export const useSetMemberRole = () => useMemberCommand<SetMemberRoleArgs>("role")
export const useKickMember = () => useMemberCommand<KickMemberArgs>("kick")
