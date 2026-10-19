"use client"

import type { QueryClient } from "@tanstack/react-query"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
import { isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"

export type ChannelRouteVerification = "present" | "missing" | "denied"

export async function startChannelRouteVerification(client: QueryClient, serverId: string | null, channelId: string): Promise<ChannelRouteVerification> {
  try {
    const resource = await client.query({ ...conversationEntryOptions(client, { channelId, serverId }), select: undefined })
    return isChannelMetadataTokenCurrent(resource.proof) ? "present" : "denied"
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined
    if (status === 403 || status === 404) return "denied"
    throw error
  }
}
