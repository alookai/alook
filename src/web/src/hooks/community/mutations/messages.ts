"use client"

import { useRef } from "react"
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import type { Msg, Attachment } from "@/components/community/_types"
import type { MessagesPage } from "@/hooks/community/use-messages"
import type { PinsResponse } from "@/hooks/community/use-channel-panels"
import type { MentionType } from "@alook/shared"

/**
 * Message-scoped mutation hooks — the split of the God-context's
 * `sendMessage`/`toggleReaction`/`pinMessage`/etc. into standalone
 * `useMutation` hooks. Every hook writes optimistic state into the shared
 * TanStack Query cache (`communityKeys.channelMessages(id)` /
 * `communityKeys.pins(id)` / etc.), performs the fetch inside `mutationFn`,
 * and rolls back via the context returned from `onMutate` when the request
 * fails.
 *
 * Rules of engagement:
 * - Never invalidate on success unless there's no server-broadcast path — the
 *   WS handler already patches the cache. Over-invalidating causes a
 *   double-fetch (WS invalidate then success invalidate).
 * - Reads from cache via `queryClient.getQueryData` for the pre-mutation
 *   snapshot, never from parent-supplied props — snapshots must be captured
 *   at the same instant they're written back on rollback.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

type PageCache = InfiniteData<MessagesPage>

/**
 * Insert an optimistic message into the newest page. Pages carry ASC rows;
 * "newest" is the FIRST page (pageParam=null). Consumers of `useMessages`
 * concatenate in reverse-page order (oldest page first), so appending to
 * page 0 places the new row at the end of the visible list.
 */
function prependOptimistic(
  cache: PageCache | undefined,
  msg: Msg,
): PageCache | undefined {
  if (!cache) return cache
  if (cache.pages.length === 0) return cache
  const [first, ...rest] = cache.pages
  return {
    ...cache,
    pages: [{ ...first, messages: [...first.messages, msg] }, ...rest],
  }
}

/**
 * Swap an optimistic `temp_` id for the server-assigned id after a successful
 * POST. Walks every page since there's no guarantee which page the row lives
 * in (though the newest is the only realistic one for a fresh insert).
 */
function reconcileServerId(
  cache: PageCache | undefined,
  tempId: string,
  serverId: string,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === tempId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) =>
        m.id === tempId ? { ...m, id: serverId } : m,
      ),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function removeById(
  cache: PageCache | undefined,
  id: string,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    const filtered = p.messages.filter((m) => m.id !== id)
    if (filtered.length === p.messages.length) return p
    touched = true
    return { ...p, messages: filtered }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function markFailedById(
  cache: PageCache | undefined,
  id: string,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === id)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) =>
        m.id === id ? { ...m, failed: true } : m,
      ),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

/**
 * Materialize the attachment view-model from the API attachment shape.
 * Mirrors the old context's conversion at `postWithOptimisticInsert`.
 */
function toAttachmentVm(
  a: { url: string; filename: string; contentType: string; size: number },
): Attachment {
  const isImage = a.contentType.startsWith("image/")
  if (isImage) return { kind: "image", name: a.filename, url: a.url }
  return {
    kind: "file",
    name: a.filename,
    url: a.url,
    size: a.size ? `${Math.round(a.size / 1024)} KB` : "",
  }
}

// Random-ish temp id — collision on the same tick is essentially impossible
// with the second-tier `Math.random` mixin.
export function tempMessageId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// ── Send message (channel/thread) ──────────────────────────────────────────

export type SendMessageArgs = {
  channelId: string
  content: string
  replyToId?: string
  mentionType?: MentionType
  attachments?: { url: string; filename: string; contentType: string; size: number }[]
  author: { id: string; name: string; avatar: string }
}

export type SendMessageResult = { message: { id: string } }

/**
 * Channel/thread send. The server infers thread-vs-channel routing from the
 * channel row's `parentChannelId` (per #14), so the client always POSTs to
 * `/channels/:id/messages`.
 */
export function useSendMessage() {
  const queryClient = useQueryClient()
  return useMutation<
    SendMessageResult,
    Error,
    SendMessageArgs,
    { tempId: string; key: readonly unknown[] }
  >({
    mutationFn: async ({ channelId, content, replyToId, mentionType, attachments }) => {
      return apiFetch<SendMessageResult>(
        `/api/community/channels/${channelId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content, replyToId, mentionType, attachments }),
        },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.channelMessages(args.channelId)
      await queryClient.cancelQueries({ queryKey: key })
      const tempId = tempMessageId()
      const cache = queryClient.getQueryData<PageCache>(key)
      let replyTo: Msg["replyTo"] | undefined
      if (args.replyToId && cache) {
        for (const page of cache.pages) {
          const original = page.messages.find((m) => m.id === args.replyToId)
          if (original) {
            replyTo = {
              id: args.replyToId,
              authorName: original.authorName ?? "Unknown",
              text: (original.content ?? "").slice(0, 100),
            }
            break
          }
        }
        if (!replyTo) {
          replyTo = { id: args.replyToId, authorName: "Unknown", text: "" }
        }
      }
      const optimisticAttachments = args.attachments?.map(toAttachmentVm)
      const msg: Msg = {
        id: tempId,
        // #3: stamp the sender's userId onto optimistic rows so
        // `useChannelWatermark` recognizes them as self-authored (skip
        // client PUT — server-side write path already writes the sender's
        // watermark on POST, see #1).
        authorId: args.author.id,
        authorName: args.author.name,
        authorAvatar: args.author.avatar,
        content: args.content,
        createdAt: new Date().toISOString(),
        ...(replyTo ? { replyTo } : {}),
        ...(optimisticAttachments?.length ? { attachments: optimisticAttachments } : {}),
      }
      queryClient.setQueryData<PageCache>(key, (c) => prependOptimistic(c, msg))
      return { tempId, key }
    },
    onError: (_err, _args, ctx) => {
      if (!ctx) return
      queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.channelMessages>, (c) =>
        markFailedById(c, ctx.tempId),
      )
    },
    onSuccess: (data, _args, ctx) => {
      if (!ctx) return
      queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.channelMessages>, (c) =>
        reconcileServerId(c, ctx.tempId, data.message.id),
      )
    },
  })
}

// ── Send DM message ────────────────────────────────────────────────────────

export type SendDmMessageArgs = {
  dmId: string
  content: string
  replyToId?: string
  attachments?: { url: string; filename: string; contentType: string; size: number }[]
  author: { id: string; name: string; avatar: string }
}

export function useSendDmMessage() {
  const queryClient = useQueryClient()
  return useMutation<
    SendMessageResult,
    Error,
    SendDmMessageArgs,
    { tempId: string; key: readonly unknown[] }
  >({
    mutationFn: async ({ dmId, content, replyToId, attachments }) => {
      return apiFetch<SendMessageResult>(
        `/api/community/dm/${dmId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content, replyToId, attachments }),
        },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.dmMessages(args.dmId)
      await queryClient.cancelQueries({ queryKey: key })
      const tempId = tempMessageId()
      const optimisticAttachments = args.attachments?.map(toAttachmentVm)
      const msg: Msg = {
        id: tempId,
        authorName: args.author.name,
        authorAvatar: args.author.avatar,
        content: args.content,
        createdAt: new Date().toISOString(),
        ...(optimisticAttachments?.length ? { attachments: optimisticAttachments } : {}),
      }
      queryClient.setQueryData<PageCache>(key, (c) => prependOptimistic(c, msg))
      return { tempId, key }
    },
    onError: (err, _args, ctx) => {
      if (!ctx) return
      // 403 "blocked" is a friendly signal (recipient has blocked the sender) —
      // scrub the optimistic row and show a scoped toast rather than leaving a
      // `failed: true` bubble in place. Mirrors the old context's `onBlocked`
      // branch at contexts/community/context.tsx:1021-1027.
      if (err instanceof ApiError && err.status === 403 && err.message === "blocked") {
        queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.dmMessages>, (c) =>
          removeById(c, ctx.tempId),
        )
        toast("You cannot send messages to this user")
        return
      }
      queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.dmMessages>, (c) =>
        markFailedById(c, ctx.tempId),
      )
    },
    onSuccess: (data, _args, ctx) => {
      if (!ctx) return
      queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.dmMessages>, (c) =>
        reconcileServerId(c, ctx.tempId, data.message.id),
      )
    },
  })
}

// ── Toggle reaction ────────────────────────────────────────────────────────

export type ToggleReactionArgs = {
  channelId?: string
  dmId?: string
  messageId: string
  emoji: string
  userId: string
}

type ToggleReactionCtx = {
  key: readonly unknown[]
  originalMe: boolean
}

// Apply an optimistic reaction toggle to any page cache that contains the
// message. This mirrors the reducer in the God-context.
function togglePageCacheReaction(
  cache: PageCache | undefined,
  messageId: string,
  emoji: string,
  userId: string,
  add: boolean,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === messageId)) return p
    touched = true
    const nextMessages = p.messages.map((m) => {
      if (m.id !== messageId) return m
      const reactions = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
      const existing = reactions.find((r) => r.emoji === emoji)
      if (add) {
        if (existing) {
          if (!existing.userIds.includes(userId)) {
            existing.userIds.push(userId)
            existing.count = existing.userIds.length
          }
          existing.me = true
        } else {
          reactions.push({ emoji, count: 1, me: true, userIds: [userId] })
        }
      } else if (existing) {
        existing.userIds = existing.userIds.filter((id) => id !== userId)
        existing.count = existing.userIds.length
        existing.me = false
        if (existing.count <= 0) reactions.splice(reactions.indexOf(existing), 1)
      }
      return { ...m, reactions }
    })
    return { ...p, messages: nextMessages }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function currentMeStatus(
  cache: PageCache | undefined,
  messageId: string,
  emoji: string,
): boolean {
  if (!cache) return false
  for (const p of cache.pages) {
    const msg = p.messages.find((m) => m.id === messageId)
    if (!msg) continue
    return msg.reactions?.find((r) => r.emoji === emoji)?.me ?? false
  }
  return false
}

/**
 * Toggle a reaction on a message. Optimistic: flips `me` immediately, rolls
 * back on server failure. The HTTP method (`PUT` add vs `DELETE` remove) is
 * derived from the cache read at call-time inside `mutationFn` — capturing
 * the original state before the optimistic flip.
 *
 * Note: consumers usually want `useToggleReactionApi()` below — a
 * fire-and-forget callable — because reactions don't need pending UI.
 */
export function useToggleReaction() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, ToggleReactionArgs, ToggleReactionCtx>({
    mutationFn: async (args, ..._rest) => {
      // Re-read cache at call time to pick the correct verb. The optimistic
      // write in onMutate has already flipped `me` in cache, but we captured
      // `originalMe` in the context — pull it from there via a ref map. In
      // practice mutationFn doesn't receive ctx, so we re-derive from the
      // originalMe stashed by `onMutate` in a shared closure via `queryClient
      // .getMutationCache()`. Simpler: encode the verb into args pre-call.
      void _rest
      const key = args.channelId
        ? communityKeys.channelMessages(args.channelId)
        : args.dmId
        ? communityKeys.dmMessages(args.dmId)
        : communityKeys.channelMessages("__none__")
      // The cache at this point reflects the optimistic flip. Reverse-derive:
      // if the current `me` after flip is TRUE, we're adding; ELSE removing.
      const cache = queryClient.getQueryData<PageCache>(key)
      const meAfterFlip = currentMeStatus(cache, args.messageId, args.emoji)
      const method = meAfterFlip ? "PUT" : "DELETE"
      const url = `/api/community/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}`
      await apiFetch(url, { method })
    },
    onMutate: async (args) => {
      const key = args.channelId
        ? communityKeys.channelMessages(args.channelId)
        : args.dmId
        ? communityKeys.dmMessages(args.dmId)
        : communityKeys.channelMessages("__none__")
      await queryClient.cancelQueries({ queryKey: key })
      const cache = queryClient.getQueryData<PageCache>(key)
      const originalMe = currentMeStatus(cache, args.messageId, args.emoji)
      const nextMe = !originalMe
      queryClient.setQueryData<PageCache>(key, (c) =>
        togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, nextMe),
      )
      return { key, originalMe }
    },
    onError: (_err, args, ctx) => {
      if (!ctx) return
      queryClient.setQueryData<PageCache>(ctx.key as ReturnType<typeof communityKeys.channelMessages>, (c) =>
        togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, ctx.originalMe),
      )
    },
  })
}

// #9: 300ms coalescing window. A user tapping the same reaction pill in rapid
// succession should collapse to one API call whose verb matches the final
// state vs the *original* server state at first click — never a burst of
// racing PUT/DELETE pairs. Mirrors the old context at
// contexts/community/context.tsx:1061-1130.
const REACTION_DEBOUNCE_MS = 300

/** Testing hook — clears any pending reaction timers without firing. */
export function _resetReactionTimers_forTesting() {
  const timers = useCommunityStore.getState().reactionTimers
  for (const { timer } of timers.values()) clearTimeout(timer)
  timers.clear()
}

/**
 * Practical toggle-reaction callback. Because the fetch verb (`PUT`/`DELETE`)
 * depends on the pre-toggle `me` state, we express the pattern here as a
 * stable closure that (a) writes the optimistic toggle synchronously, (b)
 * schedules the fetch behind a 300ms debounce keyed by `${messageId}:${emoji}`
 * so rapid re-clicks collapse to one request measured against the *original*
 * server state at first click, and (c) rolls back on failure.
 *
 * The pending-timer map lives on `useCommunityStore.reactionTimers` — its
 * `reset()` (fired on sign-out) clears any outstanding timers before they can
 * hit an already-torn-down cache.
 */
export function useToggleReactionApi(): (args: ToggleReactionArgs) => void {
  const queryClient = useQueryClient()
  return (args) => {
    const key = args.channelId
      ? communityKeys.channelMessages(args.channelId)
      : args.dmId
      ? communityKeys.dmMessages(args.dmId)
      : communityKeys.channelMessages("__none__")
    const cache = queryClient.getQueryData<PageCache>(key)
    const wasMe = currentMeStatus(cache, args.messageId, args.emoji)
    const nextMe = !wasMe
    // Optimistic write is always synchronous — the debounce only defers the
    // API call, not the visible UI.
    queryClient.setQueryData<PageCache>(key, (c) =>
      togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, nextMe),
    )

    const timerKey = `${args.messageId}:${args.emoji}`
    const reactionTimers = useCommunityStore.getState().reactionTimers
    const pending = reactionTimers.get(timerKey)
    if (pending) {
      clearTimeout(pending.timer)
      // If this click reverts to the ORIGINAL server state (net-zero over the
      // debounce window), cancel outright — no API call ever fires.
      if (pending.originalMe === nextMe) {
        reactionTimers.delete(timerKey)
        return
      }
    }
    // `originalMe` is the server state at the very first click in this window
    // — subsequent clicks within 300ms retain that capture so the final API
    // verb reflects the true diff, not the intermediate optimistic flip-flops.
    const originalMe = pending?.originalMe ?? wasMe

    const timer = setTimeout(() => {
      reactionTimers.delete(timerKey)
      const method = originalMe ? "DELETE" : "PUT"
      const url = `/api/community/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}`
      apiFetch(url, { method }).catch(() => {
        // Roll back to the original server state on failure.
        queryClient.setQueryData<PageCache>(key, (c) =>
          togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, originalMe),
        )
      })
    }, REACTION_DEBOUNCE_MS)
    reactionTimers.set(timerKey, { timer, originalMe })
  }
}

// ── Pin / unpin ────────────────────────────────────────────────────────────

export type PinMessageArgs = { channelId: string; messageId: string }

/**
 * Pin a message. The pins list (`communityKeys.pins(channelId)`) is small; we
 * refetch on success rather than reconstructing the enriched Msg locally.
 */
export function usePinMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, PinMessageArgs, { key: readonly unknown[] } | undefined>({
    mutationFn: async ({ channelId, messageId }) => {
      await apiFetch(`/api/community/channels/${channelId}/pins`, {
        method: "POST",
        body: JSON.stringify({ messageId }),
      })
    },
    onSuccess: (_data, args) => {
      // Server broadcasts pin.add which triggers cache invalidation via WS.
      // Still poke pins() here so a same-tab pinner sees it before the WS
      // arrives (avoids "wait, did I click that?" flicker).
      void queryClient.invalidateQueries({ queryKey: communityKeys.pins(args.channelId) })
    },
  })
}

export type UnpinMessageArgs = { channelId: string; messageId: string }

export function useUnpinMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, UnpinMessageArgs, { snapshot: PinsResponse | undefined; key: readonly unknown[] }>({
    mutationFn: async ({ channelId, messageId }) => {
      await apiFetch(`/api/community/channels/${channelId}/pins/${messageId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.pins(args.channelId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<PinsResponse>(key)
      queryClient.setQueryData<PinsResponse | undefined>(key, (prev) =>
        prev ? { ...prev, pins: prev.pins.filter((p) => p.id !== args.messageId) } : prev,
      )
      return { snapshot, key }
    },
    onError: (_err, _args, ctx) => {
      if (!ctx) return
      if (ctx.snapshot) queryClient.setQueryData(ctx.key, ctx.snapshot)
    },
  })
}

// ── Create thread ──────────────────────────────────────────────────────────

export type CreateThreadArgs = {
  channelId: string // parent channel — used to invalidate the threads list
  messageId: string
  name: string
}

export type CreateThreadResult = { id: string }

export function useCreateThread() {
  const queryClient = useQueryClient()
  return useMutation<CreateThreadResult, Error, CreateThreadArgs>({
    mutationFn: async ({ messageId, name }) => {
      return apiFetch<CreateThreadResult>(
        `/api/community/messages/${messageId}/threads`,
        { method: "POST", body: JSON.stringify({ name }) },
      )
    },
    onSuccess: (data, args) => {
      // Live-patch the message row so the "Open thread" affordance appears
      // immediately, then invalidate the thread list.
      queryClient.setQueryData<PageCache>(
        communityKeys.channelMessages(args.channelId),
        (cache) => {
          if (!cache) return cache
          let touched = false
          const pages = cache.pages.map((p) => {
            if (!p.messages.some((m) => m.id === args.messageId)) return p
            touched = true
            return {
              ...p,
              messages: p.messages.map((m) =>
                m.id === args.messageId
                  ? { ...m, thread: { id: data.id, name: args.name, messageCount: 0 } }
                  : m,
              ),
            }
          })
          if (!touched) return cache
          return { ...cache, pages }
        },
      )
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.channelId) })
    },
  })
}

// ── Read state ─────────────────────────────────────────────────────────────

// #13 read-stampede: debounce mark-channel-read at 500ms per channelId. On
// unmount / channel switch, `flushPendingReads()` runs any pending timer
// immediately so the user's last-read pointer isn't lost.
export const MARK_CHANNEL_READ_DEBOUNCE_MS = 500

/**
 * A single pending mark-read carries the debounce timer, a `fire` closure,
 * and the most recently queued `messageId` (or `undefined` for a no-body
 * mass mark-read). Re-scheduling within the debounce window replaces the
 * pending `messageId` — monotone forward semantics live one layer up in
 * `useChannelWatermark`, so this layer just uses whichever value the last
 * caller passed.
 *
 * Both the timer callback and `flushPendingReads()` invoke `fire` — same
 * code path, whether the window elapsed naturally or was flushed early.
 */
type PendingRead = {
  timer: ReturnType<typeof setTimeout>
  fire: () => void
  // Latest queued message id — captured in the closure so `fire` reads the
  // freshest value even after the timer was scheduled with a stale one.
  messageId: string | undefined
}
const pendingReads = new Map<string, PendingRead>()

/** Testing hook — clears any pending mark-read timer without firing. */
export function _resetPendingReads_forTesting() {
  for (const p of pendingReads.values()) clearTimeout(p.timer)
  pendingReads.clear()
}

/**
 * Flush every pending mark-read immediately. Each entry's `fire` runs the
 * same code the timer would have — so `onDone` (typically the inbox
 * invalidate) still fires exactly once per PUT, even when a caller flushes
 * mid-window.
 */
export function flushPendingReads() {
  const pending = [...pendingReads.values()]
  for (const p of pending) {
    clearTimeout(p.timer)
    p.fire()
  }
}

export type ScheduleMarkReadOpts = {
  /**
   * When set, PUT `{ lastMessageId }` — advances the read pointer to that
   * message's `(createdAt, id)`. Omit for the mass mark-read case (no body).
   * The mutation layer trusts whatever value the caller passes most
   * recently; monotonicity is the caller's responsibility (see
   * `useChannelWatermark`).
   */
  messageId?: string
  onDone: () => void
}

/**
 * Debounce a mark-channel-read PUT. Same-channel re-invokes within the
 * 500ms window replace the pending intent (previous `messageId` and
 * `onDone` are dropped; the new pair takes over). Nothing is left "hanging"
 * because `mutationFn` no longer awaits the debounced work.
 */
export function scheduleMarkRead(
  channelId: string,
  opts: ScheduleMarkReadOpts,
): void {
  const existing = pendingReads.get(channelId)
  if (existing) clearTimeout(existing.timer)
  // `entry` is captured inside `fire` so it can read the freshest
  // `messageId` at the moment the PUT actually issues — even if a later
  // schedule call updated it in place. Cleaner than closing over a mutable
  // outer variable.
  const entry: PendingRead = {
    // Timer is filled in below after fire is defined.
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    messageId: opts.messageId,
    fire: () => {
      // Idempotent: if the map has already moved on (fire ran, or a fresh
      // scheduling replaced us), do nothing. This is what makes it safe for
      // both the timer AND `flushPendingReads()` to call `fire` in the same
      // tick — only the first wins.
      const cur = pendingReads.get(channelId)
      if (cur !== entry) return
      pendingReads.delete(channelId)
      const body = entry.messageId
        ? JSON.stringify({ lastMessageId: entry.messageId })
        : undefined
      const init: RequestInit = body
        ? { method: "PUT", body }
        : { method: "PUT" }
      void apiFetch(`/api/community/channels/${channelId}/read`, init)
        .then(() => opts.onDone())
        .catch(() => {
          // Silent — the inbox will reconcile once the WS invalidate fires.
        })
    },
  }
  entry.timer = setTimeout(entry.fire, MARK_CHANNEL_READ_DEBOUNCE_MS)
  pendingReads.set(channelId, entry)
}

export type MarkChannelReadArgs = { channelId: string }

/**
 * Debounced mark-channel-read for the mass "mark whole channel read" path
 * (no specific messageId). After #3, no in-repo caller invokes this — the
 * eager mass mark-read on sidebar-click / inbox-open was removed, and
 * `useMarkAllInboxRead` POSTs to the three inbox read-all routes directly.
 * Kept as a stable API for future bulk mark-read affordances (per-channel context
 * menu, "mark from here down", etc.) and to document the shape of a
 * no-body PUT.
 *
 * For per-viewport watermark advances (Slack-style progressive read), use
 * `useAdvanceChannelWatermark` below, which passes a specific `messageId`.
 *
 * This hook:
 * 1. Debounces the PUT per `channelId` (500ms) so a burst of triggers
 *    collapses to a single request.
 * 2. Invalidates `communityKeys.inbox()` and `communityKeys.servers()` after
 *    the PUT — one refetch cycle, not three unrelated per-feed fetches.
 * 3. On unmount / channel switch, `flushPendingReads()` forces the pending
 *    PUT to fire so the pointer isn't stranded in the debounce window.
 *
 * Note: `mutationFn` resolves synchronously (fire-and-forget). The PUT and
 * the inbox invalidate happen inside `scheduleMarkRead`'s `onDone`, NOT in
 * TanStack's `onSuccess`. This is deliberate — the previous design wrapped
 * the setTimeout inside the mutationFn's Promise, and a same-channel
 * re-invoke (which clears the timer) or a `flushPendingReads()` call would
 * strand the Promise's `resolve()` forever.
 */
export function useMarkChannelRead() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MarkChannelReadArgs>({
    mutationFn: async ({ channelId }) => {
      scheduleMarkRead(channelId, {
        onDone: () => {
          // Single invalidate on the whole inbox prefix — refreshes all three
          // feeds under one round-trip. Do NOT invalidate on WS message.create;
          // that debounce lives in useCommunityWs.
          void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
          // Marking a channel read drops any unread mention rows for that
          // channel — refresh the server list so the rail badge decrements.
          void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
        },
      })
      // Resolve immediately — the debounced work runs independently. Callers
      // don't (and shouldn't) block on the eventual PUT.
    },
    onMutate: async (_args) => {
      // Optimistic inbox trim so the popover updates instantly. The server
      // reconciles on the WS invalidate.
      queryClient.setQueryData<{ servers: { serverId: string; serverName: string; channels: { channelId: string }[] }[] } | undefined>(
        communityKeys.inboxUnreads(),
        (prev) => {
          if (!prev) return prev
          const servers = prev.servers
            .map((s) => ({ ...s, channels: s.channels.filter((c) => c.channelId !== _args.channelId) }))
            .filter((s) => s.channels.length > 0)
          return { ...prev, servers }
        },
      )
    },
  })
}

// ── Advance channel watermark (progressive read) ──────────────────────────

/**
 * Thin wrapper around `scheduleMarkRead` that includes a specific
 * `messageId` in the PUT body — advances the read pointer to that
 * message's `(createdAt, id)`. Callback returned is stable across renders.
 *
 * Monotonicity (never regress) is the caller's job — this hook just carries
 * whatever id was passed to the underlying debounce. `useChannelWatermark`
 * keeps a `maxSeen` ref and only invokes this hook when it advances.
 *
 * The caller supplies the channelId + messageId at call time so a single
 * hook instance can serve multiple channels across a session; the debounce
 * key is `channelId`, so bursts against the same channel still collapse.
 */
export function useAdvanceChannelWatermark(): (
  channelId: string,
  messageId: string,
) => void {
  const queryClient = useQueryClient()
  return (channelId, messageId) => {
    scheduleMarkRead(channelId, {
      messageId,
      onDone: () => {
        void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
        void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
      },
    })
  }
}

// ── Mark DM read ───────────────────────────────────────────────────────────

export type MarkDmReadArgs = { dmId: string }

export function useMarkDmRead() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MarkDmReadArgs, { snapshot: unknown } | undefined>({
    mutationFn: async ({ dmId }) => {
      await apiFetch(`/api/community/dm/${dmId}/read`, { method: "PUT" })
    },
    onMutate: async (args) => {
      const key = communityKeys.dms()
      const snapshot = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (prev: { conversations: { id: string; unread?: boolean }[] } | undefined) =>
        prev
          ? { ...prev, conversations: prev.conversations.map((d) => (d.id === args.dmId ? { ...d, unread: false } : d)) }
          : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.dms(), ctx.snapshot)
    },
  })
}

// ── Inbox mutations ────────────────────────────────────────────────────────

export function useMarkAllInboxRead() {
  const queryClient = useQueryClient()
  // TanStack Query calls `onMutate` before `mutationFn`, so the optimistic
  // clear below wipes the for-you cache before `mutationFn` can read the
  // eventKeys. Capture the pre-clear eventKeys in `onMutate` via a ref, and
  // read them back in `mutationFn`. Ref (not module state) so parallel calls
  // from different hook instances don't stomp each other.
  const eventKeysRef = useRef<string[]>([])
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      const eventKeys = eventKeysRef.current
      await Promise.all([
        apiFetch("/api/community/inbox/mentions/read-all", { method: "POST" }),
        apiFetch("/api/community/inbox/unreads/read-all", { method: "POST" }),
        eventKeys.length > 0
          ? apiFetch("/api/community/inbox/foryou/dismiss", {
              method: "POST",
              body: JSON.stringify({ eventKeys }),
            })
          : Promise.resolve(),
      ])
    },
    onMutate: async () => {
      // Snapshot the for-you eventKeys BEFORE the optimistic clear — the
      // dismiss POST needs them and `mutationFn` runs after this hook.
      const forYou = queryClient.getQueryData<{ events: { eventKey: string }[] }>(
        communityKeys.inboxForYou(),
      )
      eventKeysRef.current = forYou?.events.map((e) => e.eventKey) ?? []
      queryClient.setQueryData(communityKeys.inboxForYou(), { events: [] })
      queryClient.setQueryData(communityKeys.inboxUnreads(), { servers: [] })
      queryClient.setQueryData(communityKeys.inboxMentions(), { mentions: [] })
    },
    onSuccess: () => {
      // "Mark everything read" clears every unread mention row — the rail
      // badges across all servers must fall to 0 in one refetch.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      // A partial write is possible (one of the three POSTs may have
      // succeeded before another failed) — refresh the rail badges too so
      // the UI reflects whatever landed on the server.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
  })
}

export type DismissForYouArgs = { eventKey: string }

export function useDismissForYouEvent() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DismissForYouArgs, { snapshot: unknown }>({
    mutationFn: async ({ eventKey }) => {
      await apiFetch("/api/community/inbox/foryou/dismiss", {
        method: "POST",
        body: JSON.stringify({ eventKeys: [eventKey] }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.inboxForYou()
      const snapshot = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (prev: { events: { eventKey: string }[] } | undefined) =>
        prev ? { ...prev, events: prev.events.filter((e) => e.eventKey !== args.eventKey) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.inboxForYou(), ctx.snapshot)
    },
  })
}

export type DeleteMentionArgs = { mentionId: string }

export function useDeleteMention() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteMentionArgs, { snapshot: unknown }>({
    mutationFn: async ({ mentionId }) => {
      await apiFetch(`/api/community/inbox/mentions/${mentionId}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      const key = communityKeys.inboxMentions()
      const snapshot = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (prev: { mentions: { id: string }[] } | undefined) =>
        prev ? { ...prev, mentions: prev.mentions.filter((m) => m.id !== args.mentionId) } : prev,
      )
      return { snapshot }
    },
    onSuccess: () => {
      // Deleting a mention row removes it from the unread-mention aggregate
      // that feeds the server rail badge — refresh so the count drops.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.inboxMentions(), ctx.snapshot)
    },
  })
}

// ── Load more messages ─────────────────────────────────────────────────────
// `fetchOlder` is exposed by `useMessages` / `useDmMessages` directly; there
// is no need for a dedicated mutation hook. Kept as a note here for clarity.
