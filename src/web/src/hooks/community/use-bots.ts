"use client"

import { useQuery, useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export type BotSummary = {
  id: string
  name: string
  description: string
  image: string | null
  machineId: string
  runtime: string
}
export type BotsResponse = { bots: BotSummary[] }

const EMPTY_BOTS: readonly BotSummary[] = Object.freeze([])

export function useBots(): UseQueryResult<BotsResponse> & { bots: BotSummary[] } {
  const query = useQuery({
    queryKey: communityKeys.bots(),
    queryFn: () => apiFetch<BotsResponse>("/api/community/bots"),
  })
  return { ...query, bots: query.data?.bots ?? (EMPTY_BOTS as BotSummary[]) }
}

export type CreateBotInput = {
  name: string
  description?: string
  machineId: string
  runtime: string
  image?: string
}

// Bot identity (name, image) is projected into friends() (self-bot rows) and
// dms() (DM peer avatars). Invalidate all three whenever the owner mutates
// a bot so open DM/friends pages re-render without a hard refresh.
function invalidateBotSurfaces(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: communityKeys.bots() })
  qc.invalidateQueries({ queryKey: communityKeys.friends() })
  qc.invalidateQueries({ queryKey: communityKeys.dms() })
}

export function useCreateBot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBotInput) =>
      apiFetch<{ bot: BotSummary }>("/api/community/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateBotSurfaces(qc),
  })
}

export function useUpdateBot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; name?: string; description?: string; image?: string | null }) =>
      apiFetch<{ bot: BotSummary }>(`/api/community/bots/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          image: input.image,
        }),
      }),
    onSuccess: () => invalidateBotSurfaces(qc),
  })
}

export function useDeleteBot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/community/bots/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateBotSurfaces(qc),
  })
}
