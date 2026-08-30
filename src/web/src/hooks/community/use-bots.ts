"use client"

import { useQuery, useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch, readUploadError } from "@/lib/api/client"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { BotActivityDay, CommunityProfilePatch } from "@/lib/community/models/people"
import { avatarInitial } from "@/lib/community/avatar"
import type { DailyUsageMetric, ReasoningEffort } from "@alook/shared"
import { useMemo } from "react"
import { readCommunityProfile } from "@/lib/community/profile-read"

export type BotUsageDay = {
  day: string
  period: "closed" | "in_progress"
  metrics: {
    input: DailyUsageMetric
    output: DailyUsageMetric
    cache: DailyUsageMetric
  }
}

export type BotTokenUsage = {
  capability: "supported" | "unsupported" | "unknown"
  days: BotUsageDay[]
}

export type BotSummary = {
  id: string
  name: string
  description: string
  image: string | null
  avatarVersion: number
  machineId: string
  runtime: string
  modelName: string | null
  reasoningEffort: ReasoningEffort | null
  runtimeConfigRevision: number
  // Context lifecycle (my-bots #516): when the agent last refreshed its context
  // (nap, session reset, or provider switch), ISO string, null if it never has. Rendered as the
  // awake-duration "Awake 17h" (Gus #672/#674 — how long the agent has been
  // awake since that refresh, not "X ago"); null (never refreshed) omits it.
  lastRefreshContextAt: string | null
  // Per-day handled/sent activity for the last 30 days (heatmap, Gus #608).
  // Sparse — only days with activity; oldest→newest; [] for a brand-new bot.
  // The heatmap builds the full 30-day calendar and fills from this by day-key.
  dailyActivity: BotActivityDay[]
  // Owner-only 30-day provider telemetry. Older optimistic mutation payloads
  // can omit it until the bots query refetches, which renders the unknown-state
  // placeholder instead of inventing zero usage.
  usage?: BotTokenUsage
}
export type BotsResponse = { bots: BotSummary[] }

const EMPTY_BOTS: readonly BotSummary[] = Object.freeze([])

function botProfilePatch(bot: Pick<
  BotSummary,
  "id" | "name" | "image" | "avatarVersion"
>): CommunityProfilePatch {
  return {
    id: bot.id,
    identityAbout: {
      name: bot.name,
      kind: "bot",
    },
    avatar: {
      avatar: bot.image ?? avatarInitial(bot.name),
      avatarVersion: bot.avatarVersion,
    },
  }
}

export function useBots(): UseQueryResult<BotsResponse> & { bots: BotSummary[] } {
  const query = useQuery({
    queryKey: communityKeys.bots(),
    queryFn: () => apiFetchProfiles<BotsResponse>(
      "/api/community/bots",
      (data) => data.bots.map(botProfilePatch),
    ),
  })
  const profilesByUserId = useCommunityWsStore((state) => state.profilesByUserId)
  const bots = useMemo(
    () => (query.data?.bots ?? EMPTY_BOTS).map((bot) => {
      const profile = readCommunityProfile(profilesByUserId.get(bot.id), bot.id)
      return {
        ...bot,
        name: profile.name,
        image: profile.avatar,
        avatarVersion: profile.avatarVersion,
      }
    }),
    [profilesByUserId, query.data?.bots],
  )
  return { ...query, bots }
}

export type CreateBotInput = {
  name: string
  description?: string
  machineId: string
  runtime: string
  image?: string
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
}

// Bot identity (name, image) is read from the global profile map. These query
// invalidations refresh the remaining bot/friend/DM relationship metadata.
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
    onSuccess: (data) => {
      const profiles = useCommunityWsStore.getState()
      profiles.patchProfiles(profiles.beginProfileSnapshot(), [botProfilePatch(data.bot)])
      invalidateBotSurfaces(qc, data.bot.id)
    },
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
  reasoningEffort?: ReasoningEffort | null
}
export type UpdateBotResponse = {
  bot: Pick<
    BotSummary,
    | "id"
    | "name"
    | "description"
    | "image"
    | "avatarVersion"
    | "runtime"
    | "modelName"
    | "reasoningEffort"
    | "runtimeConfigRevision"
  >
  applied?: boolean
  deliveryError?: boolean
  application?: "unchanged" | "next_turn" | "saved_not_applied"
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
          ...("reasoningEffort" in input
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
        }),
      }),
    onSuccess: (data) => {
      const profiles = useCommunityWsStore.getState()
      profiles.patchProfiles(profiles.beginProfileSnapshot(), [botProfilePatch(data.bot)])
      invalidateBotSurfaces(qc, data.bot.id)
    },
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
export type UploadBotAvatarResult = { url: string; avatarVersion: number }

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
    onSuccess: (data, variables) => {
      const profiles = useCommunityWsStore.getState()
      profiles.patchProfiles(profiles.beginProfileSnapshot(), [{
        id: variables.botId,
        avatar: { avatar: data.url, avatarVersion: data.avatarVersion },
      }])
      invalidateBotSurfaces(qc, variables.botId)
    },
  })
}
