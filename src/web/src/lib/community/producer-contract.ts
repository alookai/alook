import { BUSINESS_SCHEMA_VERSION, projectCommunityEventForContract, type CommunityWsEvent, type MessageDeliveryBatch } from "@alook/shared"

export function communityProducerContract() {
  return BUSINESS_SCHEMA_VERSION
}

export function projectCommunityProducerEvent(event: CommunityWsEvent, _env: unknown, sourceContract: number = BUSINESS_SCHEMA_VERSION) {
  const selected = projectCommunityEventForContract(event, BUSINESS_SCHEMA_VERSION, sourceContract)
  if (!selected) throw new Error("Community event protocol mismatch")
  return selected
}

export function projectCommunityProducerDelivery(batch: MessageDeliveryBatch, _env: unknown): MessageDeliveryBatch {
  if (batch.communityContract !== BUSINESS_SCHEMA_VERSION) throw new Error("Community delivery protocol mismatch")
  return batch
}
