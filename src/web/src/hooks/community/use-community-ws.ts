"use client"

import { useCallback, useEffect, useRef } from "react"
import { useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { useUserWs } from "@/lib/use-user-ws"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import {
  patchCacheJoin,
  patchCacheLeave,
  patchCacheUpdate,
  type MembersEnvelope,
} from "@/hooks/community/use-server-members"
import type { MessagesPage } from "@/hooks/community/use-messages"
import type {
  CommunityWsEvent,
  CommunityMessageCreate,
  CommunityReactionAdd,
  CommunityReactionRemove,
  CommunityMachineSummary,
  CommunityDmNewMessage,
  CommunityTypingStart,
  CommunityPresenceUpdate,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityChannelCreate,
  CommunityChannelUpdate,
  CommunityChannelDelete,
  CommunityChannelReorder,
  CommunityPinAdd,
  CommunityPinRemove,
  CommunityDmTyping,
  CommunityFriendRequest,
  CommunityFriendAccept,
  CommunityFriendReject,
  CommunityFriendRemove,
  CommunityFriendBlock,
  CommunityServerUpdate,
  CommunityServerDelete,
  CommunityCategoryCreate,
  CommunityCategoryUpdate,
  CommunityCategoryDelete,
  CommunityCategoryReorder,
  CommunityMentionCreate,
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityMachineUpdated,
  CommunityMachineRemoved,
} from "@alook/shared"
import { isCommunityEvent, TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"
import type { Msg, Attachment } from "@/components/community/_types"
import { avatarInitial } from "@/lib/community/avatar"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"

/**
 * Community WebSocket handler.
 *
 * Every event either patches the TanStack Query cache directly (fast — no
 * refetch) or invalidates a query key (slow — triggers refetch). The choice
 * is driven by the reconciliation table in `plans/21-community-tech-debt-pass-2.md`.
 *
 * State this hook owns *outside* the query cache:
 * - `useCommunityWsStore.onlineUserIds` — presence set, WS-only.
 * - `useCommunityWsStore.seenMessageIds` — dedup for `message.create`.
 * - `useCommunityStore.typingUsers` + `typingTimers` — typing indicator with
 *   auto-expire timers keyed by userId.
 * - `useCommunityStore.lastTypingSent` — outbound typing.start rate limit.
 *
 * The subscription (which channel/DM is focused) is read from
 * `useCommunityStore.subscription`, not from local component state — that
 * way any consumer can call `useCommunityStore.getState().subscribe(...)`
 * and the WS handler picks it up on the next event.
 */

// ── Constants ─────────────────────────────────────────────────────────────

// Debounce inbox invalidation so a busy channel doesn't fire one refetch per
// message. 500ms matches the mark-channel-read debounce so both fire once per
// message burst.
const INBOX_INVALIDATE_DEBOUNCE_MS = 500

// ── Types (kept for backwards compat with any lingering imports) ─────────

export type Subscription = {
  channelId?: string
  dmConversationId?: string
}

/**
 * DEPRECATED callback shape retained until the God-context (`contexts/
 * community/context.tsx`) is deleted in Step 4. The primary integration path
 * now writes state directly into the query cache and Zustand stores; callers
 * subscribe via `useQuery` and receive updates through those channels.
 *
 * Passing callbacks still fires them (in addition to the cache patches) so
 * legacy consumers don't observe silent regressions during the migration.
 */
export type CommunityWsCallbacks = {
  onMessage?: (event: CommunityMessageCreate) => void
  onAnyMessage?: (event: CommunityMessageCreate) => void
  onReaction?: (event: CommunityReactionAdd | CommunityReactionRemove) => void
  onTyping?: (event: CommunityTypingStart | CommunityDmTyping) => void
  onPresence?: (event: CommunityPresenceUpdate) => void
  onChildChannel?: (event: CommunityChildChannelCreate | CommunityChildChannelUpdate) => void
  onMember?: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
  onChannel?: (event: CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder) => void
  onPin?: (event: CommunityPinAdd | CommunityPinRemove) => void
  onDm?: (event: CommunityDmNewMessage | CommunityDmTyping) => void
  onFriend?: (event: CommunityFriendRequest | CommunityFriendAccept | CommunityFriendReject | CommunityFriendRemove | CommunityFriendBlock) => void
  onServer?: (event: CommunityServerUpdate | CommunityServerDelete) => void
  onCategory?: (event: CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder) => void
  onMention?: (event: CommunityMentionCreate) => void
  onMachine?: (event: CommunityMachineCreated | CommunityMachineStatus | CommunityMachineUpdated | CommunityMachineRemoved) => void
}

// ── Cache patch helpers ───────────────────────────────────────────────────

type PageCache = InfiniteData<MessagesPage>

/**
 * Insert a WS-delivered message onto the first (newest) page of the channel
 * or DM stream — the same slot `useSendMessage` writes optimistic rows into,
 * so the two paths converge. Deduplicates by id.
 */
function insertMessageIntoCache(
  cache: PageCache | undefined,
  msg: CommunityMessageCreate["message"] | CommunityDmNewMessage["message"],
): PageCache | undefined {
  if (!cache) return cache
  if (cache.pages.length === 0) return cache
  const first = cache.pages[0]
  if (first.messages.some((m) => m.id === msg.id)) return cache
  const attachments: Attachment[] | undefined = msg.attachments?.map((a) => {
    const isImage = a.contentType?.startsWith("image/")
    return isImage
      ? { kind: "image", name: a.filename, url: a.url }
      : {
          kind: "file",
          name: a.filename,
          url: a.url,
          size: a.size ? `${Math.round(a.size / 1024)} KB` : "",
        }
  })
  const isSystem = "type" in msg && (msg as { type?: string }).type === "system"
  const authorName = "authorName" in msg ? msg.authorName : "Unknown"
  const authorAvatar = "authorAvatar" in msg ? msg.authorAvatar : undefined
  const authorId = "authorId" in msg ? msg.authorId : undefined
  const replyTo = "replyTo" in msg ? (msg.replyTo as Msg["replyTo"]) : undefined
  const rendered: Msg = {
    id: msg.id,
    authorName,
    authorAvatar: authorAvatar || avatarInitial(authorName ?? ""),
    content: msg.content,
    createdAt: msg.createdAt,
    ...(isSystem ? { type: "system" as const } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments?.length ? { attachments } : {}),
    // #3: preserve authorId so `useChannelWatermark` can skip self-authored
    // messages when advancing the read pointer (avoids a redundant PUT — the
    // server-side write path already sets the sender's `lastReadMessageId`
    // on send, see #1).
    ...(authorId ? { authorId } : {}),
  }
  return {
    ...cache,
    pages: [{ ...first, messages: [...first.messages, rendered] }, ...cache.pages.slice(1)],
  }
}

function applyReactionToCache(
  cache: PageCache | undefined,
  event: CommunityReactionAdd | CommunityReactionRemove,
  viewerUserId: string | null,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === event.messageId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) => {
        if (m.id !== event.messageId) return m
        const reactions = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
        if (event.type === "community:reaction.add") {
          const existing = reactions.find((r) => r.emoji === event.emoji)
          if (existing) {
            if (!existing.userIds.includes(event.userId)) {
              existing.userIds.push(event.userId)
              existing.count = existing.userIds.length
            }
            if (viewerUserId && event.userId === viewerUserId) existing.me = true
          } else {
            reactions.push({
              emoji: event.emoji,
              count: 1,
              me: !!viewerUserId && event.userId === viewerUserId,
              userIds: [event.userId],
            })
          }
        } else {
          const idx = reactions.findIndex((r) => r.emoji === event.emoji)
          if (idx !== -1) {
            reactions[idx].userIds = reactions[idx].userIds.filter((id) => id !== event.userId)
            reactions[idx].count = reactions[idx].userIds.length
            if (viewerUserId && event.userId === viewerUserId) reactions[idx].me = false
            if (reactions[idx].count <= 0) reactions.splice(idx, 1)
          }
        }
        return { ...m, reactions }
      }),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

// ── Public hook ────────────────────────────────────────────────────────────

/**
 * Optional args — the community feature needs to know the viewer's userId so
 * reactions from that user light up the "me" flag. Passing null keeps the
 * hook usable in places where the viewer identity isn't yet loaded.
 */
export type UseCommunityWsOptions = CommunityWsCallbacks & {
  viewerUserId?: string | null
}

// Overload for the new call-site: `useCommunityWs()` with no args — the hook
// runs cache reconciliation and returns `{ subscribe, unsubscribe, sendTyping }`.
// The legacy signature `useCommunityWs({ onMessage, ... })` still works during
// the God-context migration; callbacks fire in addition to cache patches.
// Module-level slot for the currently-active WS `send`. The root-mounted
// `useCommunityWs` writes into this on connect so free helpers below can
// dispatch typing events without needing to re-mount the hook (which would
// open a second WebSocket per consumer). Cleared on unmount.
let activeSend: ((msg: object) => void) | null = null

/** Testing hook — clears the module-scoped `activeSend` binding. */
export function _resetActiveSend_forTesting() {
  activeSend = null
}

/**
 * Subscribe to a channel/thread/DM. Free helper so any component can update
 * the focused subscription without holding a reference to `useCommunityWs`.
 */
export function communityWsSubscribe(target: Subscription) {
  useCommunityStore.getState().subscribe(target)
}

export function communityWsUnsubscribe() {
  useCommunityStore.getState().unsubscribe()
}

/**
 * Send a typing indicator. Client-side debounced at 8s per channelId /
 * dmConversationId. If no WS is connected, the call is a no-op — subsequent
 * connections don't retroactively fire missed typings.
 */
export function communityWsSendTyping(target: {
  channelId?: string
  dmConversationId?: string
  threadId?: string
}) {
  const key = target.channelId || target.dmConversationId || target.threadId || ""
  if (!key) return
  const send = activeSend
  if (!send) return

  const now = Date.now()
  const map = useCommunityStore.getState().lastTypingSent
  const lastSent = map.get(key) || 0
  if (now - lastSent < TYPING_INDICATOR_TIMEOUT_MS) return

  map.set(key, now)
  send({ type: "community:typing.start", ...target })
}

export function useCommunityWs(options?: UseCommunityWsOptions) {
  const queryClient = useQueryClient()
  const viewerUserIdRef = useRef<string | null>(options?.viewerUserId ?? null)
  viewerUserIdRef.current = options?.viewerUserId ?? null
  const callbacksRef = useRef<CommunityWsCallbacks>(options ?? {})
  callbacksRef.current = options ?? {}

  // #3: the previous WS-driven auto-mark-read (a `useMarkChannelRead()` call
  // fired on every foreign-authored message in the focused channel) has
  // been removed. The IntersectionObserver in `useChannelWatermark` is now
  // authoritative — if a WS-delivered message actually becomes visible in
  // the viewport, IO advances the read pointer; if the user is scrolled up
  // reading history, the pointer stays put (which is the correct behavior).

  // Debounced inbox invalidation. Grouping repeated invalidations into one
  // refetch cycle keeps the popover from re-rendering on every message tick.
  const inboxDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleInboxInvalidate = useCallback(() => {
    if (inboxDebounce.current) return
    inboxDebounce.current = setTimeout(() => {
      inboxDebounce.current = null
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
    }, INBOX_INVALIDATE_DEBOUNCE_MS)
  }, [queryClient])

  const handleMessage = useCallback(
    (msg: { type: string;[key: string]: unknown }) => {
      if (!isCommunityEvent(msg)) return
      const event = msg as CommunityWsEvent
      const sub = useCommunityStore.getState().subscription
      const wsStore = useCommunityWsStore.getState()
      const cbs = callbacksRef.current
      const matchesFocus = (
        e: { channelId?: string; dmConversationId?: string },
      ): boolean => {
        if (!sub.channelId && !sub.dmConversationId) return false
        if (e.dmConversationId && sub.dmConversationId) return e.dmConversationId === sub.dmConversationId
        if (e.channelId && sub.channelId) return e.channelId === sub.channelId
        return false
      }

      switch (event.type) {
        // ── Message create ──────────────────────────────────────────────
        case "community:message.create": {
          if (wsStore.hasSeenMessage(event.message.id)) return
          wsStore.markSeenMessage(event.message.id)

          // 1) Patch the focused channel/dm page cache if the event matches.
          if (event.channelId && event.channelId === sub.channelId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.channelMessages(event.channelId),
              (c) => insertMessageIntoCache(c, event.message),
            )
          } else if (event.dmConversationId && event.dmConversationId === sub.dmConversationId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.dmMessages(event.dmConversationId),
              (c) => insertMessageIntoCache(c, event.message),
            )
          }

          // 2) Every message.create — regardless of focus — schedules a
          //    debounced inbox invalidation. Skip messages authored by the
          //    viewer since they never affect their own unreads.
          const viewerId = viewerUserIdRef.current
          if (event.message.authorId !== viewerId) {
            scheduleInboxInvalidate()
          }

          // Note: no auto-mark-read here. See #3 — the
          // IntersectionObserver in `useChannelWatermark` advances the
          // read pointer when a message actually becomes visible in the
          // viewport. If the user is scrolled up reading history, their
          // pointer must stay put; the WS handler cannot know whether the
          // incoming message is on screen.

          // Legacy callback fanout — cache patches above are authoritative.
          cbs.onAnyMessage?.(event)
          if (matchesFocus(event)) cbs.onMessage?.(event)
          return
        }

        // ── Reactions ───────────────────────────────────────────────────
        case "community:reaction.add":
        case "community:reaction.remove": {
          const viewerId = viewerUserIdRef.current
          if (event.channelId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.channelMessages(event.channelId),
              (c) => applyReactionToCache(c, event, viewerId),
            )
          }
          if (event.dmConversationId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.dmMessages(event.dmConversationId),
              (c) => applyReactionToCache(c, event, viewerId),
            )
          }
          if (matchesFocus(event)) cbs.onReaction?.(event)
          return
        }

        // ── Pins ────────────────────────────────────────────────────────
        case "community:pin.add":
        case "community:pin.remove": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.pins(event.channelId) })
          if (matchesFocus(event)) cbs.onPin?.(event)
          return
        }

        // ── Typing (channel/thread) ─────────────────────────────────────
        case "community:typing.start": {
          const userId = event.userId
          const viewerId = viewerUserIdRef.current
          if (viewerId && userId === viewerId) return
          // Focus check: only surface typing for the currently-viewed target.
          // A DM-only typing.start (no channelId) must NOT fire while the
          // viewer is focused on a channel — `matchesFocus` handles both axes.
          if (!matchesFocus(event)) return
          applyTypingIndicator(userId)
          cbs.onTyping?.(event)
          return
        }

        // ── Child channels (threads + forum posts) ──────────────────────
        case "community:channel.child_create":
        case "community:channel.child_update": {
          // Cheap invalidate for the thread + forum-post lists. The parent
          // messages list also needs an update because the parent message's
          // thread indicator (`msg.thread`) changes — do a targeted
          // setQueryData patch when we know parentMessageId.
          void queryClient.invalidateQueries({
            queryKey: communityKeys.threads(event.parentChannelId),
          })
          void queryClient.invalidateQueries({
            queryKey: communityKeys.forumPosts(event.parentChannelId),
          })
          if (event.type === "community:channel.child_create") {
            if (event.parentMessageId) {
              queryClient.setQueryData<PageCache>(
                communityKeys.channelMessages(event.parentChannelId),
                (cache) => {
                  if (!cache) return cache
                  let touched = false
                  const pages = cache.pages.map((p) => {
                    if (!p.messages.some((m) => m.id === event.parentMessageId)) return p
                    touched = true
                    return {
                      ...p,
                      messages: p.messages.map((m) =>
                        m.id === event.parentMessageId
                          ? {
                              ...m,
                              thread: {
                                id: event.channel.id,
                                name: event.channel.name,
                                // #4: a freshly-created child channel has no
                                // messages yet — `1` was a false claim that
                                // the create event carried the first message
                                // (it doesn't; the message arrives separately).
                                messageCount: 0,
                              },
                            }
                          : m,
                      ),
                    }
                  })
                  if (!touched) return cache
                  return { ...cache, pages }
                },
              )
            }
          } else {
            // child_update — sync counts/name on the parent message's thread
            // indicator if the update carries them.
            const changes = event.changes
            if (changes.messageCount !== undefined || changes.name !== undefined) {
              queryClient.setQueryData<PageCache>(
                communityKeys.channelMessages(event.parentChannelId),
                (cache) => {
                  if (!cache) return cache
                  let touched = false
                  const pages = cache.pages.map((p) => {
                    if (!p.messages.some((m) => m.thread?.id === event.channelId)) return p
                    touched = true
                    return {
                      ...p,
                      messages: p.messages.map((m) =>
                        m.thread?.id === event.channelId
                          ? {
                              ...m,
                              thread: {
                                ...m.thread,
                                ...(changes.name !== undefined ? { name: changes.name } : {}),
                                ...(changes.messageCount !== undefined
                                  ? { messageCount: changes.messageCount }
                                  : {}),
                              },
                            }
                          : m,
                      ),
                    }
                  })
                  if (!touched) return cache
                  return { ...cache, pages }
                },
              )
            }
          }
          cbs.onChildChannel?.(event)
          return
        }

        // ── Server ──────────────────────────────────────────────────────
        case "community:server.update":
        case "community:server.delete": {
          if (event.type === "community:server.update") {
            queryClient.setQueryData<ServerDetail | undefined>(
              communityKeys.server(event.serverId),
              (prev) =>
                prev
                  ? {
                      ...prev,
                      name: event.changes.name ?? prev.name,
                      description: event.changes.description ?? prev.description,
                      // #8: icon can be explicitly cleared (null). `??` treats
                      // null the same as undefined, which would keep the old
                      // icon after a removal — check `undefined` explicitly.
                      icon:
                        event.changes.icon !== undefined
                          ? event.changes.icon
                          : prev.icon,
                    }
                  : prev,
            )
            queryClient.setQueryData<ServersResponse | undefined>(
              communityKeys.servers(),
              (prev) =>
                prev
                  ? {
                      ...prev,
                      servers: prev.servers.map((s) =>
                        s.id === event.serverId
                          ? {
                              ...s,
                              ...(event.changes.name ? { name: event.changes.name, initial: avatarInitial(event.changes.name) } : {}),
                              ...(event.changes.icon !== undefined ? { icon: event.changes.icon ?? null } : {}),
                            }
                          : s,
                      ),
                    }
                  : prev,
            )
          } else {
            void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
            queryClient.removeQueries({ queryKey: communityKeys.server(event.serverId) })
            // #10: if the deleted server is the one the viewer is looking at,
            // the store pointers now dangle — reset them so the UI drops back
            // to a safe default instead of rendering a ghost server/channel.
            const store = useCommunityStore.getState()
            if (store.currentServerId === event.serverId) {
              store.setCurrentServerId(null)
              store.setCurrentChannelId(null)
            }
          }
          cbs.onServer?.(event)
          return
        }

        // ── Channels / categories → refetch the server detail ───────────
        case "community:channel.create":
        case "community:channel.update":
        case "community:channel.delete":
        case "community:channel.reorder":
        case "community:category.create":
        case "community:category.update":
        case "community:category.delete":
        case "community:category.reorder": {
          // #3: on channel.delete, evict every channel-scoped cache before
          // invalidating the server. Without this the messages/pins/threads/
          // forum-posts caches for the dead channel linger forever — a
          // subsequent same-id revive (rare, but the server can reuse ids)
          // would surface stale rows.
          if (event.type === "community:channel.delete") {
            queryClient.removeQueries({
              queryKey: communityKeys.channelMessages(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.pins(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.threads(event.channelId),
            })
            queryClient.removeQueries({
              queryKey: communityKeys.forumPosts(event.channelId),
            })
          }
          if ("serverId" in event) {
            void queryClient.invalidateQueries({ queryKey: communityKeys.server(event.serverId) })
          }
          if (event.type.startsWith("community:channel.")) {
            cbs.onChannel?.(event as CommunityChannelCreate | CommunityChannelUpdate | CommunityChannelDelete | CommunityChannelReorder)
          } else {
            cbs.onCategory?.(event as CommunityCategoryCreate | CommunityCategoryUpdate | CommunityCategoryDelete | CommunityCategoryReorder)
          }
          return
        }

        // ── Members ─────────────────────────────────────────────────────
        case "community:member.join":
        case "community:member.leave":
        case "community:member.update": {
          const key = communityKeys.members(event.serverId)
          if (event.type === "community:member.join") {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheJoin(cache, event),
            )
          } else if (event.type === "community:member.leave") {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheLeave(cache, event),
            )
          } else {
            queryClient.setQueryData<InfiniteData<MembersEnvelope> | undefined>(
              key,
              (cache) => patchCacheUpdate(cache, event),
            )
          }
          // Membership just changed → the invite dialog's "friends who aren't
          // in this server" list is stale. Cheap invalidation because the
          // query is disabled unless the dialog is actually open.
          if (event.type !== "community:member.update") {
            void queryClient.invalidateQueries({
              queryKey: communityKeys.invitableFriends(event.serverId),
            })
          }
          cbs.onMember?.(event)
          return
        }

        // ── Friends ─────────────────────────────────────────────────────
        case "community:friend.request":
        case "community:friend.accept":
        case "community:friend.reject":
        case "community:friend.remove":
        case "community:friend.block": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
          cbs.onFriend?.(event)
          return
        }

        // ── DM new message ──────────────────────────────────────────────
        case "community:dm.new_message": {
          if (wsStore.hasSeenMessage(event.message.id)) return
          wsStore.markSeenMessage(event.message.id)

          // Focus-scope patch (mirrors community message.create).
          if (event.dmConversationId === sub.dmConversationId) {
            queryClient.setQueryData<PageCache>(
              communityKeys.dmMessages(event.dmConversationId),
              (c) => insertMessageIntoCache(c, event.message),
            )
          }
          // Refresh DM sidebar (preview + unread mark).
          void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
          scheduleInboxInvalidate()
          cbs.onDm?.(event)
          return
        }

        // ── DM typing ───────────────────────────────────────────────────
        case "community:dm.typing": {
          const viewerId = viewerUserIdRef.current
          if (viewerId && event.userId === viewerId) return
          if (event.dmConversationId !== sub.dmConversationId) return
          applyTypingIndicator(event.userId)
          cbs.onDm?.(event)
          cbs.onTyping?.(event)
          return
        }

        // ── Presence — no cache; write to WS store ──────────────────────
        case "community:presence.update": {
          useCommunityWsStore.getState().setPresence(event.userId, event.online)
          cbs.onPresence?.(event)
          return
        }

        // ── Mentions ────────────────────────────────────────────────────
        case "community:mention.create": {
          void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
          // The server rail badge counts unread mentions per server; refresh
          // it on every new mention. No debounce — mention.create is rare
          // and the servers list is small.
          void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
          cbs.onMention?.(event)
          return
        }

        // ── Machines ────────────────────────────────────────────────────
        case "community:machine.created": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) => {
              if (!prev) return { machines: [event.machine] }
              const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
              if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
              const next = prev.machines.slice()
              next[idx] = event.machine
              return { ...prev, machines: next }
            },
          )
          useCommunityStore.getState().setPendingMachineTokenId(event.tokenId)
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.status": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) =>
              prev
                ? {
                    ...prev,
                    machines: prev.machines.map((m) =>
                      m.id === event.machineId
                        ? { ...m, lastSeenAt: event.lastSeenAt, status: event.status }
                        : m,
                    ),
                  }
                : prev,
          )
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.updated": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) => {
              if (!prev) return { machines: [event.machine] }
              const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
              if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
              const next: CommunityMachineSummary[] = prev.machines.slice()
              next[idx] = event.machine
              return { ...prev, machines: next }
            },
          )
          cbs.onMachine?.(event)
          return
        }
        case "community:machine.removed": {
          queryClient.setQueryData<MachinesResponse | undefined>(
            communityKeys.machines(),
            (prev) =>
              prev ? { ...prev, machines: prev.machines.filter((m) => m.id !== event.machineId) } : prev,
          )
          cbs.onMachine?.(event)
          return
        }
      }
    },
    [queryClient, scheduleInboxInvalidate],
  )

  const { send } = useUserWs(handleMessage)

  // Publish the send binding so free helpers (`communityWsSendTyping`) can
  // dispatch without holding a hook reference. Single-instance assumption
  // matches the "mount at tree root" contract; if a second call site invoked
  // the hook, the last one would win. Cleared on unmount.
  useEffect(() => {
    // #15: warn if a second hook instance has mounted while another is still
    // active. Two live subscribers would each publish their own `send` into
    // this module slot — the second mount overwrites the first, and the
    // first's cleanup then clears the slot mid-flight (see the `activeSend
    // === send` check below). Whoever added the second mount site should
    // co-locate them under a single root-level `useCommunityWs()` call.
    if (activeSend !== null && activeSend !== send) {
      // eslint-disable-next-line no-console
      console.warn(
        "[useCommunityWs] Multiple instances detected — mount this hook once at the tree root.",
      )
    }
    activeSend = send
    return () => {
      if (activeSend === send) activeSend = null
    }
  }, [send])

  // ── Public methods ───────────────────────────────────────────────────────

  /** Subscribe to a channel/thread/DM (writes to the Zustand store). */
  const subscribe = useCallback((target: Subscription) => {
    useCommunityStore.getState().subscribe(target)
  }, [])

  const unsubscribe = useCallback(() => {
    useCommunityStore.getState().unsubscribe()
  }, [])

  /**
   * Send a typing indicator. Client-side debounced at 8s per channelId /
   * dmConversationId. The DO also applies server-side dedup.
   */
  const sendTyping = useCallback(
    (target: { channelId?: string; dmConversationId?: string; threadId?: string }) => {
      const key = target.channelId || target.dmConversationId || target.threadId || ""
      if (!key) return

      const now = Date.now()
      const map = useCommunityStore.getState().lastTypingSent
      const lastSent = map.get(key) || 0
      if (now - lastSent < TYPING_INDICATOR_TIMEOUT_MS) return

      // Mutate the map in place — no equality change, no re-render (nothing
      // subscribes to it). Keeping it in the store keeps the lifetime tied
      // to `reset()` on sign-out.
      map.set(key, now)
      send({ type: "community:typing.start", ...target })
    },
    [send],
  )

  // Cleanup: flush the inbox debounce if the hook unmounts mid-window so the
  // parent surface doesn't leave a scheduled fetch dangling.
  useEffect(() => {
    return () => {
      if (inboxDebounce.current) {
        clearTimeout(inboxDebounce.current)
        inboxDebounce.current = null
      }
    }
  }, [])

  return {
    subscribe,
    unsubscribe,
    sendTyping,
  }
}

// ── Typing indicator helpers ─────────────────────────────────────────────────

/**
 * Append userId to `typingUsers` and start (or extend) an auto-expire timer.
 * The timer removes the user from the list after `TYPING_INDICATOR_TIMEOUT_MS`
 * if no follow-up typing event arrives.
 */
function applyTypingIndicator(userId: string) {
  useCommunityStore.setState((state) => {
    const timers = state.typingTimers
    const existing = timers.get(userId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      useCommunityStore.setState((s) => {
        const nextTimers = new Map(s.typingTimers)
        nextTimers.delete(userId)
        return {
          typingUsers: s.typingUsers.filter((id) => id !== userId),
          typingTimers: nextTimers,
        }
      })
    }, TYPING_INDICATOR_TIMEOUT_MS)
    const nextTimers = new Map(timers)
    nextTimers.set(userId, timer)
    const nextUsers = state.typingUsers.includes(userId)
      ? state.typingUsers
      : [...state.typingUsers, userId]
    return { typingUsers: nextUsers, typingTimers: nextTimers }
  })
}

