"use client"

import { useQuery,useMutation,useQueryClient,type UseQueryResult,type Query,type QueryKey,type MutateOptions } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import {
apiFetchProfiles,
beginCommunityProfileSeed,
writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { BotActivityDay,CommunityProfilePatch } from "@/lib/community/models/people"
import { avatarInitial } from "@/lib/community/avatar"
import type { DailyUsageMetric,ReasoningEffort } from "@alook/shared"
import { useCallback,useMemo } from "react"
import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"


import { useCommunityMutationOrigin as useBotMutationOrigin } from "./community-origin"

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
  isActive: boolean
  presence: "online" | "offline"
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
export type BotPlanSummary = {
  isFounder: boolean
  plan: {
    id: string
    displayName: string
  }
  limit: number
  ownedCount: number
  activeCount: number
}
type BotsResponse = BotPlanSummary & { bots: BotSummary[] }
type BotResource = Omit<BotSummary, "name" | "description" | "image" | "avatarVersion" | "presence">
export type BotsResourceResponse = BotPlanSummary & { bots: BotResource[] }

type OriginalBotView = (() => void) & { signal: AbortSignal }
type BotViewInput = { assertActive?: OriginalBotView }

function botProfilePatch(bot: Pick<BotSummary, "id" | "name" | "image" | "avatarVersion"> & { description?: string }): CommunityProfilePatch {
  return { id: bot.id, identityAbout: { name: bot.name, kind: "bot", ...("discriminator" in bot && typeof bot.discriminator === "string" ? { discriminator: bot.discriminator } : {}), ...(bot.description === undefined ? {} : { aboutMe: bot.description }) }, avatar: { avatar: bot.image ?? avatarInitial(bot.name), avatarVersion: bot.avatarVersion } }
}

export function useBots(): UseQueryResult<BotsResourceResponse> & { bots: BotSummary[] } {
  const query = useQuery({
    queryKey: communityKeys.bots(),
    queryFn: async ({ client, signal }): Promise<BotsResourceResponse> => {
      const data = await apiFetchProfiles<BotsResponse>("/api/community/bots", (data) => data.bots.map((bot) => ({ ...botProfilePatch(bot), presence: bot.presence })), { signal }, getCommunityDbRegistry(client))
      return { ...data, bots: data.bots.map(({ name: _name, description: _description, image: _image, avatarVersion: _avatarVersion, presence: _presence, ...resource }) => resource) }
    },
  })
  const profiles = useCanonicalProfilesByUserId(query.data?.bots.map((bot) => bot.id) ?? [])
  const bots = useMemo(() => (query.data?.bots ?? []).map((bot) => {
    const profile = readCommunityProfile(profiles.get(bot.id), bot.id)
    return { ...bot, name: profile.name, description: profile.aboutMe, image: profile.avatar, avatarVersion: profile.avatarVersion, presence: profile.presence }
  }), [profiles, query.data?.bots])
  return { ...query, bots }
}

type BotCommandContext = {
  client: ReturnType<typeof useQueryClient>
  resources: Query[]
  assert: () => void
  request: <T>(path: string, options?: ApiRequestOptions) => Promise<T>
  publishProfile: (patch: CommunityProfilePatch) => void
}
const botSurfaceKeys = (id?: string) => [communityKeys.bots(), communityKeys.friends(), communityKeys.dms(), ...(id ? [communityKeys.profile(id)] : [])]

const allBotSurfaceKeys = () => botSurfaceKeys()
const botIdSurfaceKeys = ({ id }: { id: string }) => botSurfaceKeys(id)
const botAvatarSurfaceKeys = ({ botId }: { botId: string }) => botSurfaceKeys(botId)
const botAuditKeys = ({ id }: { id: string }) => [communityKeys.botAuditLog(id)]
const noBotKeys = () => []

function useBotCommand<TInput extends BotViewInput, TResult>(kind: string, execute: (input: TInput, context: BotCommandContext) => Promise<TResult>, keys: (input: TInput) => QueryKey[]) {
  const client = useQueryClient(), origin = useBotMutationOrigin()
  type Intent = { input: TInput; original: ReturnType<typeof origin.begin>["token"]; resources: Query[] }
  const native = useMutation<TResult, Error, Intent>({
    mutationKey: [...communityKeys.bots(), kind],
    scope: { id: "community-bot-command" },
    gcTime: 0,
    mutationFn: async ({ input, original, resources }) => {
      const assert = () => { origin.assert(original); input.assertActive?.() }
      assert()
      const snapshot = beginCommunityProfileSeed(origin.registry)
      const context: BotCommandContext = {
        client, resources, assert,
        request: (path, options) => origin.request(original, path, { ...options, signal: input.assertActive?.signal, assertActive: assert }),
        publishProfile: (patch) => { assert(); writeCommunityProfilePatches([patch], origin.registry, { snapshot, command: true }) },
      }
      try {
        for (const resource of resources) if (client.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) await client.cancelQueries({ queryKey: resource.queryKey, exact: true })
        assert()
        await origin.registry!.collections.profiles.preload()
        assert()
        const result = await execute(input, context)
        assert()
        return result
      } finally {
        try {
          origin.assert(original)
          for (const resource of resources) if (client.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) void client.invalidateQueries({ queryKey: resource.queryKey, exact: true }).catch(() => undefined)
        } catch {}
      }
    },
  })
  const capture = useCallback((input: TInput): Intent => {
    input.assertActive?.()
    return { input, original: origin.begin().token, resources: [...new Set(keys(input).flatMap((queryKey) => client.getQueryCache().findAll({ queryKey })))] }
  }, [origin, client, keys])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.input.assertActive?.() }, [origin])
  return useNativeMutationFacade<TResult, Error, TInput, Intent, unknown>(native, capture, assertCurrent)
}

export type CreateBotInput = BotViewInput & {
  name: string
  description?: string
  machineId: string
  runtime: string
  image?: string
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
}

export function invalidateBotSurfaces(client: ReturnType<typeof useQueryClient>, id?: string, originalResources?: Query[]) {
  const resources = originalResources ?? [...new Set(botSurfaceKeys(id).flatMap((queryKey) => client.getQueryCache().findAll({ queryKey })))]
  for (const resource of resources) if (client.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) void client.invalidateQueries({ queryKey: resource.queryKey, exact: true }).catch(() => undefined)
}

export function useCreateBot() {
  return useBotCommand<CreateBotInput, { bot: BotSummary }>("create-command", async ({ assertActive: _assertActive, ...input }, context) => {
    const data = await context.request<{ bot: BotSummary }>("/api/community/bots", { method: "POST", body: JSON.stringify(input) })
    context.publishProfile(botProfilePatch(data.bot))
    return data
  }, allBotSurfaceKeys)
}

export type SetBotActiveInput = BotViewInput & { id: string; active: boolean }
export type SetBotActiveResponse = { bot: Pick<BotSummary, "id" | "isActive">; changed: boolean }

export function useSetBotActive() {
  return useBotCommand<SetBotActiveInput, SetBotActiveResponse>("active-command", async ({ id, active }, context) => {
    const key = communityKeys.bots(), resource = context.resources.find((resource) => resource.queryHash === context.client.getQueryCache().find({ queryKey: key, exact: true })?.queryHash)
    const before = resource?.state.dataUpdateCount
    const data = await context.request<SetBotActiveResponse>("/api/community/bots/" + id + "/active", { method: "PATCH", body: JSON.stringify({ active }) })
    context.assert()
    if (resource && context.client.getQueryCache().find({ queryKey: key, exact: true }) === resource && resource.state.dataUpdateCount === before) context.client.setQueryData<BotsResourceResponse>(key, (current) => {
      if (!current) return current
      const previous = current.bots.find((bot) => bot.id === data.bot.id)
      if (!previous || previous.isActive === data.bot.isActive) return current
      return { ...current, activeCount: Math.max(0, current.activeCount + (data.bot.isActive ? 1 : -1)), bots: current.bots.map((bot) => bot.id === data.bot.id ? { ...bot, isActive: data.bot.isActive } : bot) }
    })
    return data
  }, botIdSurfaceKeys)
}

export type UpdateBotInput = {
  id: string
  assertActive?: OriginalBotView
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
  return useBotCommand<UpdateBotInput, UpdateBotResponse>("update-command", async ({ id, assertActive: _assertActive, ...input }, context) => {
    const data = await context.request<UpdateBotResponse>("/api/community/bots/" + id, { method: "PATCH", body: JSON.stringify(input) })
    context.publishProfile(botProfilePatch(data.bot))
    const key = communityKeys.bots(), resource = context.resources.find((resource) => context.client.getQueryCache().find({ queryKey: key, exact: true }) === resource)
    if (resource) context.client.setQueryData<BotsResourceResponse>(key, (current) => current ? { ...current, bots: current.bots.map((bot) => bot.id === id && bot.runtimeConfigRevision <= data.bot.runtimeConfigRevision ? { ...bot, runtime: data.bot.runtime, modelName: data.bot.modelName, reasoningEffort: data.bot.reasoningEffort, runtimeConfigRevision: data.bot.runtimeConfigRevision } : bot) } : current)
    return data
  }, botIdSurfaceKeys)
}

type BotIdInput = BotViewInput & { id: string }
const botIdInput = (input: string | BotIdInput) => typeof input === "string" ? { id: input } : input
function useBotIdFacade<TResult>(native: ReturnType<typeof useBotCommand<BotIdInput, TResult>>) {
  type Input = string | BotIdInput
  const qualify = useCallback((input: Input, callbacks?: MutateOptions<TResult, Error, Input, unknown>): MutateOptions<TResult, Error, BotIdInput, unknown> | undefined => callbacks && ({
    onSuccess: (data, _intent, result, context) => callbacks.onSuccess?.(data, input, result, context),
    onError: (error, _intent, result, context) => callbacks.onError?.(error, input, result, context),
    onSettled: (data, error, _intent, result, context) => callbacks.onSettled?.(data, error, input, result, context),
  }), [])
  const nativeMutate = native.mutate, nativeMutateAsync = native.mutateAsync
  const mutate = useCallback((input: Input, callbacks?: MutateOptions<TResult, Error, Input, unknown>) => nativeMutate(botIdInput(input), qualify(input, callbacks)), [nativeMutate, qualify])
  const mutateAsync = useCallback((input: Input, callbacks?: MutateOptions<TResult, Error, Input, unknown>) => nativeMutateAsync(botIdInput(input), qualify(input, callbacks)), [nativeMutateAsync, qualify])
  return { ...native, mutate, mutateAsync }
}
export function useDeleteBot() {
  const native = useBotCommand<BotIdInput, void>("delete-command", async ({ id }, context) => { await context.request<void>("/api/community/bots/" + id, { method: "DELETE" }) }, botIdSurfaceKeys)
  return useBotIdFacade<void>(native)
}

export type ResetBotSessionResult = { ok: true }
export function useResetBotSession() {
  const native = useBotCommand<BotIdInput, ResetBotSessionResult>("reset-command", ({ id }, context) => context.request<ResetBotSessionResult>("/api/community/bots/" + id + "/reset-session", { method: "POST" }), botAuditKeys)
  return useBotIdFacade<ResetBotSessionResult>(native)
}

export type ResetMachineAgentsResult = { dispatched: number }
export function useResetMachineAgents() {
  const native = useBotCommand<BotIdInput, ResetMachineAgentsResult>("machine-reset-command", ({ id }, context) => context.request<ResetMachineAgentsResult>("/api/community/machines/" + id + "/reset-agents", { method: "POST" }), noBotKeys)
  return useBotIdFacade<ResetMachineAgentsResult>(native)
}

export type UploadBotAvatarArgs = BotViewInput & { botId: string; file: File }
export type UploadBotAvatarResult = { url: string; avatarVersion: number }
export function useUploadBotAvatar() {
  return useBotCommand<UploadBotAvatarArgs, UploadBotAvatarResult>("avatar-command", async ({ botId, file }, context) => {
    const body = new FormData()
    body.append("file", file)
    const data = await context.request<UploadBotAvatarResult>("/api/community/bots/" + botId + "/avatar", { method: "POST", body })
    context.publishProfile({ id: botId, avatar: { avatar: data.url, avatarVersion: data.avatarVersion } })
    return data
  }, botAvatarSurfaceKeys)
}
