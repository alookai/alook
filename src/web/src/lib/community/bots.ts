import { queryOptions } from "@tanstack/react-query"
import { parseCommunityBotsProfileRead, CommunityBotProfileSummarySchema, type CommunityBotsProfileRead } from "@alook/shared"
import type { DailyUsageMetric, ReasoningEffort } from "@alook/shared"
import type { BotActivityDay, CommunityProfilePatch } from "./models/people"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import { apiFetchProfiles } from "./profile-seed"

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
  isActive?: boolean
  presence?: "online" | "offline"
  // Context lifecycle (my-bots #516): when the agent last refreshed its context
  // (nap, session reset, or provider switch), ISO string, null if it never has. Rendered as the
  // awake-duration "Awake 17h" (Gus #672/#674 — how long the agent has been
  // awake since that refresh, not "X ago"); null (never refreshed) omits it.
  lastRefreshContextAt?: string | null
  // Per-day handled/sent activity for the last 30 days (heatmap, Gus #608).
  // Sparse — only days with activity; oldest→newest; [] for a brand-new bot.
  // The heatmap builds the full 30-day calendar and fills from this by day-key.
  dailyActivity?: BotActivityDay[]
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
type BotResource = Omit<BotSummary, "name" | "description" | "image" | "avatarVersion" | "presence">
export type BotsResourceResponse = Partial<BotPlanSummary> & { bots: BotResource[]; observed?: boolean; source?: "network" | "rsc" | "restored_idb" }

export type BotsResponse = BotPlanSummary & { bots: Array<BotSummary & CommunityBotsProfileRead["bots"][number]> }

export function botProfilePatch(bot: Pick<BotSummary, "id" | "name" | "image" | "avatarVersion"> & { description?: string }): CommunityProfilePatch {
  const identity = CommunityBotProfileSummarySchema.parse(bot)
  return { id: identity.id, identityAbout: { name: identity.name, kind: "bot", ...(identity.discriminator === undefined ? {} : { discriminator: identity.discriminator }), ...(identity.description === undefined ? {} : { aboutMe: identity.description }) }, avatar: { avatar: identity.image, avatarVersion: identity.avatarVersion }, ...(identity.presence === undefined ? {} : { presence: identity.presence }) }
}

function botsResource(data: BotsResponse): BotsResourceResponse {
  return { ...data, bots: data.bots.map(({ name: _name, description: _description, image: _image, avatarVersion: _avatarVersion, presence: _presence, discriminator: _discriminator, ownerUserId: _ownerUserId, ...resource }) => resource) }
}

export const botsOptions = () => queryOptions({
  queryKey: communityKeys.bots(),
  queryFn: async ({ client, signal }): Promise<BotsResourceResponse> => {
    const registry = getCommunityDbRegistry(client)
    const data = await apiFetchProfiles<BotsResponse>("/api/community/bots", data => parseCommunityBotsProfileRead(data, registry!.accountId!).bots.map(bot => { const patch = botProfilePatch(bot); return { ...patch, identityAbout: { ...patch.identityAbout, ownerUserId: bot.ownerUserId } } }), { signal }, registry)
    return { ...botsResource(data), source: "network" }
  },
  staleTime: query => query.state.data?.observed === false ? 0 : 5_000,
})
