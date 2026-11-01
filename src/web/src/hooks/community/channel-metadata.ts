import type { QueryClient } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
export type ChannelMetadata = import("@alook/shared").CommunityChannelResource & { accessDecision?: import("@alook/shared").CommunityAccessDecision }
export { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"

export function channelMetadataOptions(client: QueryClient, serverId: string | null, channelId: string, observation?: ApiRequestOptions["observation"]) {
  return conversationEntryOptions(client, { channelId, serverId }, observation)
}
