import { projectCommunityEventForContract, type CommunityContract, type CommunityWsEvent, type MessageDeliveryBatch } from "@alook/shared"

type ProducerEnvironment = { COMMUNITY_EVENT_CONTRACT?: string }

export function communityProducerContract(env: ProducerEnvironment): CommunityContract {
  if (env.COMMUNITY_EVENT_CONTRACT === "3") return 3
  return env.COMMUNITY_EVENT_CONTRACT === "2" ? 2 : 1
}

export function projectCommunityProducerEvent(event: CommunityWsEvent, env: ProducerEnvironment, sourceContract: CommunityContract = 2) {
  const selected = projectCommunityEventForContract(event, communityProducerContract(env), sourceContract)
  if (!selected) throw new Error("Community event requires producer contract v2")
  return selected
}

export function projectCommunityProducerDelivery(batch: MessageDeliveryBatch, env: ProducerEnvironment): MessageDeliveryBatch {
  if (batch.communityContract === 3 || communityProducerContract(env) !== 1 || !batch.joinedParticipantUserIds) return batch
  const { joinedParticipantUserIds: _joined, rosterRefreshUserId, ...legacy } = batch
  if (!rosterRefreshUserId || !batch.messageEvent.serverId) throw new Error("Missing committed participant scope")
  return { ...legacy, memberAdded: { userId: rosterRefreshUserId, channelId: batch.messageEvent.channelId, serverId: batch.messageEvent.serverId } }
}
