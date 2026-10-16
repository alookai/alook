import { infiniteQueryOptions, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import type { CommunityMessageSurfaceReceipt } from "@alook/shared"
import { actionAttributes } from "@/lib/observability/context"
import { emitTelemetry, telemetryGeneration } from "@/lib/observability/telemetry"
import { apiFetchCommunity } from "./account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { messageWindowPage, type MessagesPage as WireMessagesPage, type MessagesWindowPage as MessagesPage, type MessagesPageParam } from "./models/message"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "./conversation-read"

type MessagesTransportPage = WireMessagesPage & {
  surfaceReceipt?: CommunityMessageSurfaceReceipt
}

export type MessagesTransportOptions = {
  queryClient?: QueryClient
  observation?: ApiRequestOptions["observation"] | (() => ApiRequestOptions["observation"])
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
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

async function fetchMessagesTransport(
  queryClient: QueryClient,
  url: string,
  signal: AbortSignal | undefined,
  options: MessagesTransportOptions | undefined,
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<WireMessagesPage> {
  const transport = await withConversationReadDeadline(signal, (readSignal) => apiFetchCommunity<MessagesTransportPage>(
    url,
    { signal: readSignal, observation: typeof options?.observation === "function" ? options.observation() : options?.observation }, token,
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
    const captured = typeof options?.observation === "function" ? options.observation() : options?.observation
    const observation: ApiRequestOptions["observation"] = pageParam.mode === "older" || pageParam.mode === "newer"
      ? { page: captured?.page ?? captured?.action, reason: "pagination" }
      : pageParam.mode === "since" ? { page: captured?.page ?? captured?.action, reason: "background" }
      : captured?.action?.done ? { page: captured.action.name === "navigation" ? captured.action : captured.page, reason: "background" } : captured
    const generation = telemetryGeneration()
    const publicationToken = captureCommunityLiveSnapshotToken(originalClient, channelId)
    const url = buildMessagesUrl(
      `/api/community/channels/${channelId}/messages`,
      pageParam,
      tag,
    )
    const page = await fetchMessagesTransport(originalClient, url, signal, { ...options, observation }, publicationToken)
    {
      const result = publishCommunityMessages(originalClient, {
        channelId,
        messages: page.messages,
        proof: { token: publicationToken, signal },
      })
      if (result === "published" && generation === telemetryGeneration()) emitTelemetry("data.publish", { ...actionAttributes(observation?.action ?? observation?.page), source: "network", cache_stage: "canonical", request_reason: observation?.reason ?? "unknown", eligibility: "eligible", outcome: "success" })
    }
    return messageWindowPage(page)
  }

export const dmMessagesQueryFn =
  (dmId: string, options?: MessagesTransportOptions) =>
  channelMessagesQueryFn(dmId, undefined, options)

export type InitialMessageWindow = Extract<MessagesPageParam, { mode: "newest" | "anchor" | "since" }>
export type MessageWindowData = InfiniteData<MessagesPage, MessagesPageParam>

export function messageWindowIdentity(key: QueryKey): { channelId: string; initial: InitialMessageWindow; tag: string | null } | undefined {
  if (key[0] !== "community" || key[1] !== "channel" || typeof key[2] !== "string" || key[3] !== "messages") return
  if (key.length === 4) return { channelId: key[2], initial: { mode: "newest" }, tag: null }
  if (key.length === 6 && key[4] === "tag" && typeof key[5] === "string") return { channelId: key[2], initial: { mode: "newest" }, tag: key[5] }
  if (key.length !== 6 || key[4] !== "window" || !key[5] || typeof key[5] !== "object") return
  const value = key[5] as Record<string, unknown>
  if (value.tag !== null && typeof value.tag !== "string") return
  const tag = value.tag as string | null
  if (value.mode === "newest" && Object.keys(value).length === 2) return { channelId: key[2], initial: { mode: "newest" }, tag }
  if (value.mode === "anchor" && typeof value.anchor === "string" && value.anchor.length > 0 && Object.keys(value).length === 3) return { channelId: key[2], initial: { mode: "anchor", anchor: value.anchor }, tag }
  if (value.mode === "since" && typeof value.since === "string" && value.since.length > 0 && Object.keys(value).length === 3) return { channelId: key[2], initial: { mode: "since", since: value.since }, tag }
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
    retry: conversationReadRetryPolicy(client.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
  })
}

