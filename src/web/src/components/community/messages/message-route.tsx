"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCommunityRouteFrame } from "../shell/community-route-context"
import { CommunityPendingFrame } from "../shell/community-pending-frame"
import { Button } from "@/components/ui/button"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import type { OpenerPayload } from "@/hooks/community/use-message"
import type { ChannelMetadata } from "@/hooks/community/channel-metadata"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { retryConversationRead, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { systemNotificationHref } from "@/lib/community/system-notification-route"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import { tid } from "@/lib/community/testids"

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function MessageRoute({ messageId }: { messageId: string }) {
  const client = useQueryClient()
  const { frame, navigation, openInbox } = useCommunityRouteFrame()
  const href = `/c/messages/${encodeURIComponent(messageId)}`
  const active = SAFE_ID.test(messageId) && frame.pathname === href
    && normalizeCommunityHref(navigation.publishedHref).pathname === href && !navigation.navigationPending
  const current = useRef({ active, navigation })
  useLayoutEffect(() => { current.current = { active, navigation } }, [active, navigation])
  const source = useCommunityViewSource(`message-route:${messageId}`, active)
  const query = useQuery({
    queryKey: communityKeys.messageRoute(messageId), enabled: active, gcTime: 0, staleTime: 0,
    retry: retryConversationRead, networkMode: "always",
    queryFn: async ({ signal }) => {
      const original = source.capture()
      const intent = current.current.navigation.captureIntent()
      const account = captureCommunityLiveSnapshotToken(client)
      const assertCurrent = () => {
        original()
        if (!current.current.active || !intent()) throw new DOMException("Retired message route", "AbortError")
        assertCommunityLiveSnapshotTokenCurrent(client, account, signal)
      }
      return withConversationReadDeadline(AbortSignal.any([signal, original.signal]), async (readSignal) => {
        assertCurrent()
        const message = await apiFetchCommunity<OpenerPayload>(`/api/community/messages/${encodeURIComponent(messageId)}`,
          { signal: readSignal, assertActive: assertCurrent }, account)
        assertCurrent()
        if (message.id !== messageId || !message.channelId || !SAFE_ID.test(message.channelId)) throw new ApiError("Conversation unavailable", 404)
        const channel = captureCommunityLiveSnapshotToken(client, message.channelId)
        const assertChannel = () => { assertCurrent(); assertCommunityLiveSnapshotTokenCurrent(client, channel, readSignal) }
        const metadata = await apiFetchCommunity<ChannelMetadata>(`/api/community/channels/${encodeURIComponent(message.channelId)}`,
          { signal: readSignal, assertActive: assertChannel }, channel)
        assertChannel()
        if (metadata.id !== message.channelId || metadata.archived || metadata.accessDecision?.canRead === false) throw new ApiError("Conversation unavailable", 404)
        let destination: string
        if (metadata.type === "dm" && metadata.serverId === null) {
          destination = systemNotificationHref({ kind: "dm", channelId: metadata.id })
        } else if (["text", "forum", "thread"].includes(metadata.type) && metadata.serverId && SAFE_ID.test(metadata.serverId)) {
          destination = systemNotificationHref({ kind: "server", serverId: metadata.serverId, channelId: metadata.id })
        } else throw new ApiError("Conversation unavailable", 404)
        return { href: destination, assertCurrent: assertChannel }
      })
    },
  })
  useEffect(() => {
    if (!active || !query.data || query.isFetching || query.isError) return
    try { query.data.assertCurrent() } catch { return }
    navigation.replace(query.data.href)
  }, [active, navigation, query.data, query.isError, query.isFetching])

  if (!active || !query.isError) return <CommunityPendingFrame href={href} />
  const unavailable = query.error instanceof ApiError && [403, 404].includes(query.error.status)
  return <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
    <p role="alert" data-testid={tid.messageRouteAlert(messageId)} className="text-sm text-muted-foreground">{unavailable ? "This conversation is unavailable." : "Could not open this conversation."}</p>
    <div className="flex gap-2">
      {!unavailable && <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button>}
      <Button onClick={openInbox}>Open Inbox</Button>
    </div>
  </main>
}
