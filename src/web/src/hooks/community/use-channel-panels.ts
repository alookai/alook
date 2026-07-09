"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Thread, ForumPost, Msg } from "@/components/community/_types"

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_THREADS: readonly Thread[] = Object.freeze([])
const EMPTY_FORUM_POSTS: readonly ForumPost[] = Object.freeze([])
const EMPTY_PINS: readonly Msg[] = Object.freeze([])

/**
 * Fetches the thread list rendered in a channel's right rail (`?panel=threads`).
 *
 * The server already resolves parent-message / creator / first-message
 * previews server-side so the payload is render-ready. Query key is nested
 * under `communityKeys.channelMessages`'s sibling grain so an invite from
 * WS (`community:channel.child_create`) can invalidate the thread list only
 * — without touching messages.
 */
export type ThreadsResponse = { threads: Thread[] }

export const threadsQueryFn = (channelId: string) => () =>
  apiFetch<ThreadsResponse>(`/api/community/channels/${channelId}/threads`)

export function useThreads(channelId: string | null): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
} {
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled ? threadsQueryFn(channelId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    threads: query.data?.threads ?? (EMPTY_THREADS as Thread[]),
  }
}

/**
 * Fetches the forum-post listing for a `type='forum'` channel. Server-side
 * resolves creator + first-message + counts; the payload is display-ready.
 */
export type ForumPostsResponse = { posts: ForumPost[] }

export const forumPostsQueryFn = (channelId: string) => () =>
  apiFetch<ForumPostsResponse>(`/api/community/channels/${channelId}/posts`)

/**
 * Fetches forum posts. Only enabled when the channel is a `forum` — otherwise
 * the server returns 400 "channel is not a forum" and TanStack Query would
 * retry it. Callers must pass the channel's type gate; passing `false` (or a
 * null channelId) leaves the query disabled and no request fires.
 */
export function useForumPosts(
  channelId: string | null,
  isForum: boolean = true,
): UseQueryResult<ForumPostsResponse> & { posts: ForumPost[] } {
  const enabled = !!channelId && isForum
  const query = useQuery({
    queryKey: enabled ? communityKeys.forumPosts(channelId!) : communityKeys.forumPosts("__none__"),
    queryFn: enabled
      ? forumPostsQueryFn(channelId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    posts: query.data?.posts ?? (EMPTY_FORUM_POSTS as ForumPost[]),
  }
}

/**
 * Fetches the pinned-message list for a channel. Server-side hydrates the
 * author + content so no follow-up fetch is needed.
 */
export type PinsResponse = { pins: Msg[] }

export const pinsQueryFn = (channelId: string) => () =>
  apiFetch<PinsResponse>(`/api/community/channels/${channelId}/pins`)

export function usePins(channelId: string | null): UseQueryResult<PinsResponse> & {
  pins: Msg[]
} {
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.pins(channelId!) : communityKeys.pins("__none__"),
    queryFn: enabled ? pinsQueryFn(channelId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    pins: query.data?.pins ?? (EMPTY_PINS as Msg[]),
  }
}
