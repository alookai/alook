"use client"

import { useCommunityCommandMutation } from "../use-community-command-mutation"
import { beginCommunityCommandRevision } from "@/lib/community-db/sync"
import { useCommunityMutationOrigin } from "../community-origin"
import { useIsMutating, useQueryClient } from "@tanstack/react-query"
import { projectServerRailCommit, type ServerRailCommand, type ServerRailCommitResponse } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { mutateCommunityServerRail, readCommunityServerRail } from "@/lib/community-db/server-rail"
import { publishCommunityServerRailCommit } from "@/lib/community-db/sync"
import type { RailState } from "@/lib/community/server-rail-model"

export type ServerRailCommitArgs = { before: RailState; after: RailState; commands: ServerRailCommand[]; assertUI?: () => void }
const mutationKey = ["community", "server-rail", "change"] as const
export function useServerRailCommit() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const pending = useIsMutating({ mutationKey, exact: true }) > 0
  const mutation = useCommunityCommandMutation<ServerRailCommitResponse, Error, ServerRailCommitArgs>(origin, {
    mutationKey,
    scope: { id: "server-rail-commit" },
    mutationFn: async ({ commands, assertUI, original, resources }) => {
      assertUI?.()
      const registry = origin.registry
      origin.assert(original)
      await registry?.ready
      origin.assert(original)
      assertUI?.()
      await Promise.all([
        queryClient.cancelQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => resources.includes(query) }),
        queryClient.cancelQueries({ queryKey: communityKeys.folders(), exact: true, predicate: (query) => resources.includes(query) }),
      ])
      origin.assert(original)
      assertUI?.()
      const token = beginCommunityCommandRevision(queryClient, original)
      const snapshot = readCommunityServerRail(registry!)
      const optimistic = projectServerRailCommit(snapshot, { commands }, (id) => id)
      if (!optimistic.ok) throw new Error(optimistic.error)
      let response: ServerRailCommitResponse | undefined
      const transaction = registry!.dbClient.createTransaction({ mutationFn: async () => {
        try {
          assertUI?.()
          response = await apiFetch<ServerRailCommitResponse>("/api/community/users/me/server-rail", {
            method: "PATCH", body: JSON.stringify({ commands }),
            ...(() => {
              const options = communityRequestOptions(queryClient, token, undefined, () => origin.assert(original))
              return { ...options, onUnauthorized: async () => {
                try { assertUI?.() } catch { return false }
                return options.onUnauthorized ? options.onUnauthorized() : false
              } }
            })(),
          })
          origin.assert(original)
          for (const command of commands) if (command.kind === "create-folder" && !response.createdFolderIds[command.clientId]) throw new Error("Missing confirmed folder identity")
          const confirmed = projectServerRailCommit(snapshot, { commands }, (id) => response!.createdFolderIds[id]!)
          if (!confirmed.ok) throw new Error(confirmed.error)
          publishCommunityServerRailCommit(queryClient, confirmed.value, { token, signal: undefined })
        } catch (error) { origin.assert(original); throw error }
      } })
      transaction.mutate(() => mutateCommunityServerRail(registry!, optimistic.value))
      try { await transaction.isPersisted.promise } catch (error) { origin.assert(original); throw error }
      return response!
    },
    onSettled: (_response, error, args) => {
      if ((error instanceof Error && error.name === "AbortError") || !origin.registry?.runtime.lifecycle.get().active) return
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.folders(), exact: true, predicate: (query) => args.resources.includes(query) })
    },
  })
  return { ...mutation, isPending: pending, isCommandPending: () => queryClient.isMutating({ mutationKey, exact: true }) > 0 }
}
