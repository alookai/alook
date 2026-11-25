import type { InitialMessageWindow, MessageWindowData } from "./message-window-contract"
import { COMMUNITY_RESOURCE_CONTRACT_VERSION } from "@alook/shared"
import { hashKey, infiniteQueryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { COMMUNITY_CONTRACT_HEADER, type CommunityMessageSurfaceReceipt } from "@alook/shared"
import { apiFetchCommunity } from "./account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { messageWindowPage, type MessagesReadPage as WireMessagesPage, type MessagesWindowPage as MessagesPage, type MessagesPageParam } from "./models/message"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "./conversation-read"

type MessagesTransportPage = WireMessagesPage & {
  surfaceReceipt?: CommunityMessageSurfaceReceipt
}

export type MessagesTransportOptions = {
  queryClient?: QueryClient
}

export function buildMessagesUrl(base: string, pageParam: MessagesPageParam, tag?: string | null): string {
  const params = new URLSearchParams()
  if (tag) params.set("tag", tag)
  switch (pageParam.mode) {
    case "newest":
      break
    case "older":
      params.set("cursor", pageParam.cursor)
      break
    case "newer":
      params.set("since", pageParam.cursor)
      break
    case "since":
      params.set("since", pageParam.since)
      break
    case "anchor":
      params.set("anchor", pageParam.anchor)
      break
  }
  params.set("includeRefs", "1")
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

async function fetchMessagesTransport(
  url: string,
  signal: AbortSignal | undefined,
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<WireMessagesPage> {
  const transport = await withConversationReadDeadline(signal, (readSignal) => apiFetchCommunity<MessagesTransportPage>(
    url,
    { signal: readSignal, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) } }, token,
  ))
  const { surfaceReceipt: _surfaceReceipt, ...page } = transport
  return page
}

export const channelMessagesQueryFn =
  (channelId: string, tag?: string | null, options?: MessagesTransportOptions) =>
  async ({
    pageParam,
    signal,
    client,
  }: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
    client?: QueryClient
  }): Promise<MessagesPage> => {
    const originalClient = options?.queryClient ?? client
    if (!originalClient) throw new DOMException("Missing message query owner", "AbortError")
    const publicationToken = captureCommunityLiveSnapshotToken(originalClient, channelId)
    const url = buildMessagesUrl(
      `/api/community/channels/${channelId}/messages`,
      pageParam,
      tag,
    )
    const page = await fetchMessagesTransport(url, signal, publicationToken)
    await publishCommunityMessages(originalClient, {
      channelId,
      messages: page.messages,
      relatedMessages: page.relatedMessages,
      profiles: page.profiles,
      refs: page.refs,
      proof: { token: publicationToken, signal },
    })
    return messageWindowPage(page)
  }

export { messageWindowIdentity, type InitialMessageWindow, type MessageWindowData } from "./message-window-contract"

export const viewportFillFetchMeta = { fetchMore: { direction: "forward" } } as const

export function messagePageForReading(data: MessageWindowData, messageId: string, preferred?: string): string | undefined {
  const existing = data.pageParams.findIndex(param => hashKey([param]) === preferred)
  const index = existing >= 0 && data.pages[existing]?.messages.some(message => message.id === messageId)
    ? existing : data.pages.findIndex(page => page.messages.some(message => message.id === messageId))
  const param = data.pageParams[index]
  return param ? hashKey([param]) : undefined
}

export function messagePageNeighbors(data: MessageWindowData, page: string) {
  const index = data.pageParams.findIndex(param => hashKey([param]) === page)
  const current = data.pages[index]
  if (!current) return { older: false, newer: false }
  return {
    older: index === data.pages.length - 1 && !!(current.hasMoreOlder ?? current.hasMore) && !!(current.olderCursor ?? current.cursor),
    newer: index === 0 && !!current.hasMoreNewer && !!current.newerCursor,
  }
}


export function messageWindowOptions(
  client: QueryClient,
  channelId: string,
  initial: InitialMessageWindow,
  tag?: string | null,
  transport?: MessagesTransportOptions,
) {
  const queryKey = communityKeys.channelMessagesWindow(channelId, initial, tag)
  return infiniteQueryOptions<MessagesPage, Error, MessageWindowData, QueryKey, MessagesPageParam>({
    queryKey,
    queryFn: channelMessagesQueryFn(channelId, tag, { ...transport, queryClient: client }),
    initialPageParam: initial,
    getNextPageParam: (last) => {
      const cursor = last.olderCursor ?? last.cursor
      return (last.hasMoreOlder ?? last.hasMore) && cursor ? { mode: "older", cursor } : undefined
    },
    getPreviousPageParam: (first) => first.hasMoreNewer && first.newerCursor ? { mode: "newer", cursor: first.newerCursor } : undefined,
    staleTime: 5_000,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: conversationReadRetryPolicy(client.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
  })
}
