import type { QueryClient } from "@tanstack/react-query"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

export function captureChannelMetadataToken(client: QueryClient, channelId: string) {
  return captureCommunityLiveSnapshotToken(client, channelId)
}

export function isChannelMetadataTokenCurrent(token: ReturnType<typeof captureChannelMetadataToken>) {
  try { assertCommunityLiveSnapshotTokenCurrent(token.queryClient, token, undefined); return true }
  catch { return false }
}
