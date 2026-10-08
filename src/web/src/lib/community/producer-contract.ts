import { projectCommunityEventForContract, type CommunityWsEvent, type MessageDeliveryBatch } from "@alook/shared"

type ProducerEnvironment = { COMMUNITY_EVENT_CONTRACT?: string }

export function projectCommunityProducerEvent(event: CommunityWsEvent, env: ProducerEnvironment) {
  const selected = projectCommunityEventForContract(event, env.COMMUNITY_EVENT_CONTRACT === "2" ? 2 : 1)
  if (!selected) throw new Error("Community event requires producer contract v2")
  return selected
}

export function projectCommunityProducerDelivery(batch: MessageDeliveryBatch, env: ProducerEnvironment): MessageDeliveryBatch {
  if (env.COMMUNITY_EVENT_CONTRACT === "2" || !batch.joinedParticipantUserIds) return batch
  const { joinedParticipantUserIds: _joined, rosterRefreshUserId, ...legacy } = batch
  if (!rosterRefreshUserId || !batch.messageEvent.serverId) throw new Error("Missing committed participant scope")
  return { ...legacy, memberAdded: { userId: rosterRefreshUserId, channelId: batch.messageEvent.channelId, serverId: batch.messageEvent.serverId } }
}
