import type { ApiRequestOptions } from "@/lib/api/client"
import type { OnboardingInitializedBot, OnboardingInitializationStep, OnboardingInitializationCheckpoint, OnboardingInitializationResult } from "@/lib/community/models/onboarding"
export type { OnboardingInitializationStep, OnboardingInitializationCheckpoint, OnboardingInitializationResult } from "@/lib/community/models/onboarding"
import { randomBeamAvatar } from "@/lib/avatar/seed-url"
import { randomBotName } from "@/lib/community/bot-random-name"
import { formatHandle, MAX_SERVER_NAME_LENGTH, slugify } from "@alook/shared"

import { resolveStarterPack, starterPackWakePrompt, type StarterPackBotIdentity } from "./starter-packs"

export const ONBOARDING_INITIALIZATION_STEPS = [
  "creating-bots",
  "creating-room",
  "inviting-bots",
  "preparing-welcome",
] as const satisfies readonly OnboardingInitializationStep[]

export const ONBOARDING_INITIALIZATION_LABEL: Record<OnboardingInitializationStep, string> = {
  "creating-bots": "Creating your bots",
  "creating-room": "Creating your server",
  "inviting-bots": "Inviting your bots",
  "preparing-welcome": "Preparing your first conversation",
}

export type OnboardingBotCreateResponse = {
  bot: {
    id: string
    name?: string
    discriminator?: string
    image?: string | null
    avatarVersion: number
  }
}
type ServerCreateResponse = { server: { id: string; name?: string } }
type ChannelRow = { id: string; name: string }

const ROOM_NAMES: Record<string, string> = {
  office: "work-room",
  developer: "dev-room",
  founder: "founder-room",
  home: "home-room",
  operations: "operations-room",
  custom: "team-room",
}

export function onboardingRoomName(userName: string, role: string) {
  const roomName = ROOM_NAMES[role] ?? ROOM_NAMES.custom
  const userSlug = slugify(userName)
  if (!userSlug) return roomName

  const maxPrefixLength = MAX_SERVER_NAME_LENGTH - roomName.length - 1
  const userPrefix = userSlug.slice(0, maxPrefixLength).replace(/-+$/g, "")
  return userPrefix ? `${userPrefix}-${roomName}` : roomName
}

function ownerHandle(userName: string, discriminator?: string) {
  return discriminator ? `@${formatHandle(userName, discriminator)}` : userName
}

export async function initializeCommunityOnboarding({
  machineId,
  runtime,
  identity,
  userName,
  userDiscriminator,
  checkpoint = {},
  onCheckpoint,
  onProgress,
  services,
}: {
  machineId: string
  runtime: string
  identity: string
  userName: string
  userDiscriminator?: string
  checkpoint?: OnboardingInitializationCheckpoint
  onCheckpoint?: (checkpoint: OnboardingInitializationCheckpoint) => void
  onProgress?: (step: OnboardingInitializationStep) => void
  services: {
    request: <T>(path: string, options?: ApiRequestOptions) => Promise<T>
    readChannels: (serverId: string) => Promise<ChannelRow[]>
    publishBot: (bot: OnboardingBotCreateResponse["bot"], requested: { name: string; image: string }) => void
    resolveBot: (id: string) => { name: string; discriminator?: string } | undefined
    assert: () => void
  }
}): Promise<OnboardingInitializationResult> {
  services.assert()
  let progress = checkpoint
  const save = (next: OnboardingInitializationCheckpoint) => {
    services.assert()
    progress = { ...progress, ...next }
    onCheckpoint?.(progress)
  }
  const pack = resolveStarterPack(identity)

  onProgress?.("creating-bots")
  const createdByKey = new Map((progress.bots ?? []).map((bot) => [bot.key, bot]))
  for (const template of pack.bots) {
    if (createdByKey.has(template.key)) continue
    const name = template.name ?? randomBotName()
    const image = randomBeamAvatar()
    const created = await services.request<OnboardingBotCreateResponse>("/api/community/bots", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: template.publicBio,
        machineId,
        runtime,
        image,
      }),
    })
    services.assert()
    if (!created.bot.id) throw new Error("Setup progress could not be restored")
    services.publishBot(created.bot, { name, image })
    const bot: OnboardingInitializedBot = {
      key: template.key,
      id: created.bot.id,
    }
    createdByKey.set(template.key, bot)
    save({ bots: [...createdByKey.values()] })
  }

  const createdBots = pack.bots.map((template) => createdByKey.get(template.key))
  if (createdBots.some((bot) => !bot?.id)) throw new Error("Setup progress could not be restored")
  const bots = createdBots as OnboardingInitializedBot[]

  onProgress?.("creating-room")
  if (!progress.serverId) {
    const serverName = onboardingRoomName(userName, identity)
    const createdServer = await services.request<ServerCreateResponse>("/api/community/servers", {
      method: "POST",
      body: JSON.stringify({ name: serverName }),
    })
    save({
      serverId: createdServer.server.id,
      requestedServerName: serverName,
    })
  }

  const { serverId } = progress
  if (!serverId) throw new Error("Setup progress could not be restored")

  onProgress?.("inviting-bots")
  if (!progress.publicChannelId || !progress.privateChannelId) {
    const channels = await services.readChannels(serverId)
    services.assert()
    const publicChannel = channels.find((channel) => channel.name === "all")
    const privateChannel = channels.find((channel) => channel.name === "room")
    if (!publicChannel || !privateChannel) {
      throw new Error("The new room is missing its default channels")
    }
    save({ publicChannelId: publicChannel.id, privateChannelId: privateChannel.id })
  }

  const { publicChannelId, privateChannelId } = progress
  if (!publicChannelId || !privateChannelId) throw new Error("Default channels could not be restored")

  const team: StarterPackBotIdentity[] = bots.map((created) => {
    const template = pack.bots.find((candidate) => candidate.key === created.key)!
    const profile = services.resolveBot(created.id)
    if (!profile?.name) throw new Error("Bot identity could not be restored")
    return { ...template, ...created, ...profile }
  })
  const lead = team.find((bot) => bot.key === "lead")!
  const onboardingBots = team.map((bot) => ({
    id: bot.id,
    wakePrompt: starterPackWakePrompt({
      pack,
      bot,
      team,
      ownerHandle: ownerHandle(userName, userDiscriminator),
    }),
  }))

  onProgress?.("preparing-welcome")
  const onboardedBotIds = new Set(
    progress.onboardedBotIds
      ?? (progress.botsOnboarded ? team.map((bot) => bot.id) : []),
  )
  for (const bot of team) {
    if (onboardedBotIds.has(bot.id)) continue
    await services.request(`/api/community/servers/${serverId}/onboard`, {
      method: "POST",
      body: JSON.stringify({
        bots: onboardingBots,
        leadBotId: lead.id,
        action: { type: "wake", botId: bot.id },
      }),
    })
    onboardedBotIds.add(bot.id)
    save({ onboardedBotIds: [...onboardedBotIds] })
  }

  if (!progress.botsOnboarded) {
    await services.request(`/api/community/servers/${serverId}/onboard`, {
      method: "POST",
      body: JSON.stringify({
        bots: onboardingBots,
        leadBotId: lead.id,
        action: { type: "finalize" },
      }),
    })
    save({ botsOnboarded: true })
  }

  if (!progress.leadAddedToPrivate) {
    await services.request(`/api/community/channels/${privateChannelId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: lead.id }),
    })
    save({ leadAddedToPrivate: true })
  }

  services.assert()
  return {
    serverId,
    publicChannelId,
    privateChannelId,
    leadBotId: lead.id,
    bots,
  }
}
