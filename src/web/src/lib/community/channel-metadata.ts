import type { QueryClient } from "@tanstack/react-query"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
export type ChannelMetadata = import("@alook/shared").CommunityChannelResource & { accessDecision?: import("@alook/shared").CommunityAccessDecision }
export { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"

export function channelMetadataOptions(client: QueryClient, serverId: string | null, channelId: string) {
  return conversationEntryOptions(client, { channelId, serverId })
}
