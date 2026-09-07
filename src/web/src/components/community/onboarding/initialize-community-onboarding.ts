import { apiFetch } from "@/lib/api/client"
import { randomBeamAvatar } from "@/lib/avatar/seed-url"
import { randomBotName } from "@/lib/community/bot-random-name"
import { formatHandle, MAX_SERVER_NAME_LENGTH, slugify } from "@alook/shared"

import {
  resolveStarterPack,
  starterPackWakePrompt,
  type StarterPackBotIdentity,
  type StarterPackBotKey,
} from "./starter-packs"

export type OnboardingInitializationStep =
  | "creating-bots"
  | "creating-room"
  | "inviting-bots"
  | "preparing-welcome"

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

type BotCreateResponse = {
  bot: {
    id: string
    name?: string
    discriminator?: string
    image?: string | null
  }
}
type ServerCreateResponse = { server: { id: string; name?: string } }
type ChannelRow = { id: string; name: string }

type OnboardingInitializedBot = {
  key: StarterPackBotKey
  id: string
  name: string
  discriminator?: string
  image?: string | null
}

export type OnboardingInitializationResult = {
  serverId: string
  publicChannelId: string
  privateChannelId: string
  leadBotId: string
  bots: OnboardingInitializedBot[]
}

export type OnboardingInitializationCheckpoint = {
  bots?: OnboardingInitializedBot[]
  serverId?: string
  publicChannelId?: string
  privateChannelId?: string
  serverName?: string
  onboardedBotIds?: string[]
  botsOnboarded?: boolean
  leadAddedToPrivate?: boolean
}

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
}: {
  machineId: string
  runtime: string
  identity: string
  userName: string
  userDiscriminator?: string
  checkpoint?: OnboardingInitializationCheckpoint
  onCheckpoint?: (checkpoint: OnboardingInitializationCheckpoint) => void
  onProgress?: (step: OnboardingInitializationStep) => void
}): Promise<OnboardingInitializationResult> {
  let progress = checkpoint
  const save = (next: OnboardingInitializationCheckpoint) => {
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
    const created = await apiFetch<BotCreateResponse>("/api/community/bots", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: template.publicBio,
        machineId,
        runtime,
        image,
      }),
    })
    const bot: OnboardingInitializedBot = {
      key: template.key,
      id: created.bot.id,
      name: created.bot.name ?? name,
      discriminator: created.bot.discriminator,
      image: created.bot.image ?? image,
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
    const createdServer = await apiFetch<ServerCreateResponse>("/api/community/servers", {
      method: "POST",
      body: JSON.stringify({ name: serverName }),
    })
    save({
      serverId: createdServer.server.id,
      serverName: createdServer.server.name ?? serverName,
    })
  }

  const { serverId } = progress
  if (!serverId) throw new Error("Setup progress could not be restored")

  onProgress?.("inviting-bots")
  if (!progress.publicChannelId || !progress.privateChannelId) {
    const channelData = await apiFetch<{ channels: ChannelRow[] }>(
      `/api/community/servers/${serverId}/channels`,
    )
    const publicChannel = channelData.channels.find((channel) => channel.name === "all")
    const privateChannel = channelData.channels.find((channel) => channel.name === "room")
    if (!publicChannel || !privateChannel) {
      throw new Error("The new room is missing its default channels")
    }
    save({ publicChannelId: publicChannel.id, privateChannelId: privateChannel.id })
  }

  const { publicChannelId, privateChannelId } = progress
  if (!publicChannelId || !privateChannelId) throw new Error("Default channels could not be restored")

  const team: StarterPackBotIdentity[] = bots.map((created) => {
    const template = pack.bots.find((candidate) => candidate.key === created.key)!
    return { ...template, ...created }
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
    await apiFetch(`/api/community/servers/${serverId}/onboard`, {
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
    await apiFetch(`/api/community/servers/${serverId}/onboard`, {
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
    await apiFetch(`/api/community/channels/${privateChannelId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: lead.id }),
    })
    save({ leadAddedToPrivate: true })
  }

  return {
    serverId,
    publicChannelId,
    privateChannelId,
    leadBotId: lead.id,
    bots,
  }
}
