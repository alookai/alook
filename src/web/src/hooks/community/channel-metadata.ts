import type { QueryClient } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
import type { CommunityChannelResource, CommunityAccessDecision } from "@alook/shared"
export { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"

export type ChannelMetadata = CommunityChannelResource & { resourceComplete: true; accessDecision?: CommunityAccessDecision }

export function channelMetadataOptions(client: QueryClient, serverId: string | null, channelId: string, observation?: ApiRequestOptions["observation"]) {
  return conversationEntryOptions(client, { channelId, serverId }, observation)
}
