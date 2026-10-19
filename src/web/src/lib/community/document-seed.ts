import type { QueryClient } from "@tanstack/react-query"
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

export function installCommunityDocumentSeed(client: QueryClient, registry: CommunityDbRegistry, seed: CommunityDocumentSeed, sessionViewer: string | null | undefined) {
  if (seed.viewerId !== registry.accountId || seed.selfProfile.id !== registry.accountId || sessionViewer !== undefined && sessionViewer !== registry.accountId
    || seed.href !== null && readCommunityDocumentRoute(seed.href) !== seed.href) return false
  const original = captureCommunityLiveSnapshotToken(client)
  assertCommunityLiveSnapshotTokenCurrent(client, original, undefined)
  const profile = seed.selfProfile
  writeCommunityProfilePatches([{
    id: profile.id,
    identityAbout: { name: profile.name, discriminator: profile.discriminator, aboutMe: profile.aboutMe, bannerColor: profile.bannerColor },
    avatar: { avatar: profile.avatar, avatarVersion: profile.avatarVersion },
    status: { statusEmoji: profile.statusEmoji, statusText: profile.statusText },
  }], registry, { snapshot: original.profileSnapshot })
  client.setQueryData(communityKeys.selfProfile(), { id: profile.id }, { updatedAt: seed.generatedAt })
  if (seed.bots) {
    writeCommunityProfilePatches(seed.bots.bots.map(botProfilePatch), registry, { snapshot: original.profileSnapshot })
    registry.runtime.ws.actions.seedPresence(registry.runtime.ws.actions.beginPresenceSnapshot(), seed.bots.bots.flatMap(bot => bot.presence ? [[bot.id, bot.presence] as const] : []))
    client.setQueryData(communityKeys.bots(), { ...botsResource(seed.bots), source: "rsc" }, { updatedAt: seed.generatedAt })
  }
  if (seed.machines) client.setQueryData(communityKeys.machines(), { ...seed.machines, source: "rsc" }, { updatedAt: seed.generatedAt })
  if (seed.server) {
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: seed.server }, proof: { kind: "structural", token: original, signal: undefined } })
    client.setQueryData(communityKeys.server(seed.server.id), seed.server.id, { updatedAt: seed.generatedAt })
  }
  for (const { target, data } of seed.entries) {
    const token = { ...original, channelId: target.channelId }
    const resource = publishConversationEntry(client, target, data, { token }, "rsc")
    client.setQueryData(communityKeys.conversationEntry(target.channelId, target, {
      accountEpoch: original.accountEpoch, accessEpoch: original.accessEpoch,
      channelGeneration: original.channelScopes.get(target.channelId)?.generation ?? 0,
    }), resource, { updatedAt: seed.generatedAt })
  }
  assertCommunityLiveSnapshotTokenCurrent(client, original, undefined)
  registry.dbClient.hydrate(seed.db)
  return true
}

