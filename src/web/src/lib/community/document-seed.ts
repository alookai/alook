import type { QueryClient, QueryKey } from "@tanstack/react-query"
import type { CommunityConversationEntryRead } from "@alook/shared"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityProfilePatches } from "./profile-seed"
import { publishConversationEntry, type ConversationEntryTarget } from "./conversation-entry"
import type { CommunitySelfProfile } from "./self-profile.server"
import { readCommunityDocumentRoute } from "./document-route"
import { botProfilePatch, botsResource, type BotsResponse } from "./bots"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { ServerDetail } from "@/hooks/community/use-servers"

export type CommunityDocumentSeed = {
  viewerId: string
  href: string | null
  generatedAt: number
  selfProfile: CommunitySelfProfile
  entries: Array<{ target: ConversationEntryTarget; data: CommunityConversationEntryRead }>
  bots?: BotsResponse
  machines?: MachinesResponse
  server?: ServerDetail
  db: Parameters<CommunityDbRegistry["dbClient"]["hydrate"]>[0]
}

export type CommunityDocumentSeedInput = CommunityDocumentSeed | Promise<CommunityDocumentSeed | null>

export function installCommunityDocumentSeed(client: QueryClient, registry: CommunityDbRegistry, seed: CommunityDocumentSeed, sessionViewer: string | null | undefined, delivery?: {
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>
  presence: ReturnType<CommunityDbRegistry["runtime"]["ws"]["actions"]["beginPresenceSnapshot"]>
}) {
  if (seed.viewerId !== registry.accountId || seed.selfProfile.id !== registry.accountId || sessionViewer !== undefined && sessionViewer !== registry.accountId
    || seed.href !== null && readCommunityDocumentRoute(seed.href) !== seed.href) return false
  const original = delivery?.token ?? captureCommunityLiveSnapshotToken(client)
  assertCommunityLiveSnapshotTokenCurrent(client, original, undefined)
  const seedResource = (key: QueryKey, data: unknown) => {
    if (!delivery || client.getQueryData(key) === undefined) client.setQueryData(key, data, { updatedAt: seed.generatedAt })
  }
  const profile = seed.selfProfile
  writeCommunityProfilePatches([{
    id: profile.id,
    identityAbout: { name: profile.name, discriminator: profile.discriminator, aboutMe: profile.aboutMe, bannerColor: profile.bannerColor },
    avatar: { avatar: profile.avatar, avatarVersion: profile.avatarVersion },
    status: { statusEmoji: profile.statusEmoji, statusText: profile.statusText },
  }], registry, { snapshot: original.profileSnapshot })
  seedResource(communityKeys.selfProfile(), { id: profile.id })
  if (seed.bots) {
    writeCommunityProfilePatches(seed.bots.bots.map(botProfilePatch), registry, { snapshot: original.profileSnapshot })
    registry.runtime.ws.actions.seedPresence(delivery?.presence ?? registry.runtime.ws.actions.beginPresenceSnapshot(), seed.bots.bots.flatMap(bot => bot.presence ? [[bot.id, bot.presence] as const] : []))
    seedResource(communityKeys.bots(), { ...botsResource(seed.bots), source: "rsc" })
  }
  if (seed.machines) seedResource(communityKeys.machines(), { ...seed.machines, source: "rsc" })
  if (seed.server) {
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: seed.server }, proof: { kind: "structural", token: original, signal: undefined } })
    seedResource(communityKeys.server(seed.server.id), seed.server.id)
  }
  for (const { target, data } of seed.entries) {
    const token = { ...original, channelId: target.channelId }
    const resource = publishConversationEntry(client, target, data, { token }, "rsc")
    seedResource(communityKeys.conversationEntry(target.channelId, target, {
      accountEpoch: original.accountEpoch, accessEpoch: original.accessEpoch,
      channelGeneration: original.channelScopes.get(target.channelId)?.generation ?? 0,
    }), resource)
  }
  assertCommunityLiveSnapshotTokenCurrent(client, original, undefined)
  if (!delivery) registry.dbClient.hydrate(seed.db)
  return true
}

