"use client"

import { useQuery, useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch, readUploadError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { BotActivityDay } from "@/components/community/bots/bot-activity-heatmap"

export type BotSummary = {
  id: string
  name: string
  description: string
  image: string | null
  machineId: string
  runtime: string
  modelName: string | null
  // Context lifecycle (my-bots #516): when the agent last refreshed its context
  // (nap, session reset, or provider switch), ISO string, null if it never has. Rendered as the
  // awake-duration "Awake 17h" (Gus #672/#674 — how long the agent has been
  // awake since that refresh, not "X ago"); null (never refreshed) omits it.
  lastRefreshContextAt: string | null
  // Per-day handled/sent activity for the last 30 days (heatmap, Gus #608).
  // Sparse — only days with activity; oldest→newest; [] for a brand-new bot.
  // The heatmap builds the full 30-day calendar and fills from this by day-key.
  dailyActivity: BotActivityDay[]
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
  model?: string | null
}

// Bot identity (name, image) is projected into friends() (self-bot rows) and
// dms() (DM peer avatars). Invalidate all three whenever the owner mutates
// a bot so open DM/friends pages re-render without a hard refresh.
//
// The profile card fetches/caches a bot's aboutMe separately under
// communityKeys.profile(botId) with its own 5-minute staleTime
// (use-user-profile.ts) — invalidate that too whenever the bot's id is
// known, otherwise an already-opened profile card keeps showing the
// pre-edit description until the cache naturally expires.
export function invalidateBotSurfaces(qc: ReturnType<typeof useQueryClient>, botUserId?: string) {
  qc.invalidateQueries({ queryKey: communityKeys.bots() })
  qc.invalidateQueries({ queryKey: communityKeys.friends() })
  qc.invalidateQueries({ queryKey: communityKeys.dms() })
  if (botUserId) {
    qc.invalidateQueries({ queryKey: communityKeys.profile(botUserId) })
  }
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
    onSuccess: (data) => invalidateBotSurfaces(qc, data.bot.id),
  })
}

export type UpdateBotInput = {
  id: string
  name?: string
  description?: string
  image?: string | null
  // Explicit `null` clears a set model; `undefined` leaves it untouched.
  model?: string | null
  runtime?: string
}
export type UpdateBotResponse = {
  bot: Pick<BotSummary, "id" | "name" | "description" | "image" | "runtime" | "modelName">
  applied?: boolean
  deliveryError?: boolean
}

export function useUpdateBot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateBotInput) =>
      apiFetch<UpdateBotResponse>(`/api/community/bots/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          image: input.image,
          // Omit `model` entirely when undefined so the PATCH doesn't send an
          // explicit key the server would read as "clear to default".
          ...("model" in input ? { model: input.model } : {}),
          ...("runtime" in input ? { runtime: input.runtime } : {}),
        }),
      }),
    onSuccess: (data) => invalidateBotSurfaces(qc, data.bot.id),
  })
}

export function useDeleteBot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/community/bots/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => invalidateBotSurfaces(qc, id),
  })
}

export type ResetBotSessionResult = { ok: true }

export function useResetBotSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ResetBotSessionResult>(
        `/api/community/bots/${id}/reset-session`,
        { method: "POST" },
      ),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: communityKeys.botAuditLog(id) })
    },
  })
}

// Batch reset every agent bound to a machine, in one control-plane command
// (not a fan-out of single resets). v1 is dispatch-level: the response reports
// how many agents the reset was dispatched to — it does NOT track per-agent
// success (Gus's call). A machine with no live daemon → 409.
export type ResetMachineAgentsResult = { dispatched: number }

export function useResetMachineAgents() {
  return useMutation({
    mutationFn: (machineId: string) =>
      apiFetch<ResetMachineAgentsResult>(
        `/api/community/machines/${machineId}/reset-agents`,
        { method: "POST" },
      ),
  })
}

export type UploadBotAvatarArgs = { botId: string; file: File }
export type UploadBotAvatarResult = { url: string }

export function useUploadBotAvatar() {
  const qc = useQueryClient()
  return useMutation<UploadBotAvatarResult, Error, UploadBotAvatarArgs>({
    mutationFn: async ({ botId, file }) => {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`/api/community/bots/${botId}/avatar`, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw await readUploadError(res, "Upload failed")
      return (await res.json()) as UploadBotAvatarResult
    },
    onSuccess: (_data, variables) => invalidateBotSurfaces(qc, variables.botId),
  })
}
