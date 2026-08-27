"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { toast } from "sonner"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { deriveThreadName } from "@alook/shared"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { MessageRow } from "./message-row"
import { MessageShareDialog } from "./message-share-dialog"
import { displayReplyContent } from "@/lib/community/reply-content"
import { ChannelIcon } from "../channels/channel-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { formatDateLabel } from "@/lib/community/format-time"
import { DateDivider } from "../dividers"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useUiHandlers } from "@/stores/community"
import { usePinMessage, useUnpinMessage, useCreateThread, useToggleMark } from "@/hooks/community/mutations"
import type { FileAttachment, ImagePreview, MessagesPage, Msg, Reaction, RenderMsg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { useHoverCapable } from "@/hooks/use-hover-capable"
import { channelHref } from "@/lib/community/community-route"

export type ReplyTarget = { id: string; authorName: string; text: string }

// Preview window sizing — small on purpose. The sheet is a read-only
// excerpt with just enough surrounding context to make the target message
// legible; deeper browsing happens in the underlying channel view.
const CONTEXT_LIMIT = 11

type ScopeType = "channel" | "dm"

export function openMessageContextThread({
  type,
  serverId,
  threadId,
  push,
  close,
}: {
  type: ScopeType
  serverId?: string
  threadId: string
  push: (href: string) => void
  close: () => void
}): boolean {
  if (type === "dm" || !serverId) return false
  push(channelHref(serverId, threadId))
  close()
  return true
}

// A DM (type=dm) and a thread are channel rows in the same id-space, so both
// resolve through the one canonical door — no per-type URL fork. `type` is kept
// in the signatures for call-site clarity but no longer branches the path.
function seqLookupUrl(_type: ScopeType, id: string, seq: number): string {
  return `/api/community/channels/${id}/messages/seq/${seq}`
}

function anchorFetchUrl(_type: ScopeType, id: string, anchor: string, limit: number): string {
  const base = `/api/community/channels/${id}/messages`
  return `${base}?anchor=${encodeURIComponent(anchor)}&limit=${limit}`
}

type SheetCache = {
  notFound?: boolean
  anchorId?: string
  messages?: Msg[]
}

// Apply a reaction toggle to the sheet's own cache — mirrors the reducer
// `togglePageCacheReaction` in mutations/messages.ts but on this hook's flat
// `messages[]` shape instead of the main list's PageCache-of-pages shape.
function toggleSheetReaction(
  cache: SheetCache | undefined,
  messageId: string,
  emoji: string,
  userId: string,
  add: boolean,
): SheetCache | undefined {
  if (!cache?.messages) return cache
  let touched = false
  const messages = cache.messages.map((m) => {
    if (m.id !== messageId) return m
    touched = true
    const reactions: Reaction[] = (m.reactions ?? []).map((r) => ({ ...r, userIds: [...(r.userIds ?? [])] }))
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
  if (!touched) return cache
  return { ...cache, messages }
}

/**
 * Sidecar preview shown when the user clicks a `#NUMBER` ref pointing at a
 * message that isn't in the currently loaded window. Fetches ~5 above / target
 * / ~5 below via the anchor endpoint, renders them as a plain vertical stack
 * of `<MessageRow>` rows (no MessageList, no virtualization), centers the
 * target row on open.
 *
 * **Self-contained by design** — reactions, pin, copy, thread, image preview,
 * file download all live INSIDE the sheet and operate on the sheet's own
 * TanStack cache (a separate query key from the main channel). The main
 * channel's cache is deliberately untouched to avoid re-render storms in the
 * underlying `<MessageList>` and to avoid injecting mid-history rows into the
 * main window that the user would then have to scroll past. The trade-off is
 * that a reaction added here won't show in the main list until the WS event
 * patches it (which already happens on the main cache) — a moment's
 * inconsistency, but the sheet is transient, so it's the right cost.
 *
 * Reply is the ONE action that intentionally crosses back into the main
 * surface: since the sheet has no composer, clicking Reply on a preview row
 * closes the sheet and seeds the main channel's composer with that target,
 * via the `onReply` prop.
 *
 * Retry is disabled — the sheet only shows server-persisted messages, never
 * failed optimistic rows.
 */
export function MessageContextSheet({
  open,
  onOpenChange,
  channelId,
  channelLabel,
  targetSeq,
  pinnedIds,
  onOpenProfile,
  resolveUserName,
  onReply,
  type = "channel",
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channelId: string
  // Source channel's display name for the header — a message ref opens this
  // sheet to preview a (possibly other) channel's message in place, so the
  // header names which channel's context this is (Gus #417/#423, Alli #420).
  channelLabel?: string
  targetSeq: number | null
  pinnedIds?: Set<string>
  onOpenProfile?: OpenProfile
  resolveUserName?: (userId: string) => string
  // Fired when Reply is clicked in the sheet. Parent should seed its
  // composer's replyTo state AND close the sheet — the sheet is a
  // read-only preview, replying belongs on the main surface.
  onReply?: (target: ReplyTarget) => void
  type?: ScopeType
}) {
  const currentUser = useCurrentUser()
  const uiHandlers = useUiHandlers()
  const queryClient = useQueryClient()
  const router = useRouter()
  const routeParams = useParams<{ serverId?: string }>()
  const pinMessageMut = usePinMessage()
  const unpinMessageMut = useUnpinMessage()
  const createThreadMut = useCreateThread()
  const toggleMark = useToggleMark()

  const queryKey = useMemo(
    () => ["messageContext", type, channelId, targetSeq] as const,
    [type, channelId, targetSeq],
  )

  // Two-step fetch: seq → id, then anchor-fetch around the id.
  const query = useQuery({
    queryKey,
    enabled: open && !!channelId && !!targetSeq,
    queryFn: async ({ signal }): Promise<SheetCache> => {
      let lookup: { id: string }
      try {
        lookup = await apiFetch<{ id: string }>(
          seqLookupUrl(type, channelId, targetSeq!),
          { signal },
        )
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { notFound: true }
        throw e
      }
      const page = await apiFetch<MessagesPage>(
        anchorFetchUrl(type, channelId, lookup.id, CONTEXT_LIMIT),
        { signal },
      )
      const messages = (page.messages ?? []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      return { notFound: false, anchorId: lookup.id, messages }
    },
    staleTime: 30_000,
  })

  const renderRows = useMemo<RenderMsg[]>(() => {
    if (!query.data || query.data.notFound || !query.data.messages) return []
    const src = query.data.messages
    // Same grouping heuristic the main list uses (adjacent same-author within
    // ~5 min → collapse header). Inlined here rather than sharing the util
    // because the excerpt is small enough that the extra dep isn't worth the
    // module coupling.
    return src.map((m, i) => {
      const prev = i > 0 ? src[i - 1] : null
      const grouped =
        !!prev &&
        prev.authorId != null &&
        prev.authorId === m.authorId &&
        prev.type === m.type &&
        !!prev.createdAt &&
        !!m.createdAt &&
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000
      return { ...m, grouped }
    })
  }, [query.data])

  const anchorId = query.data && !query.data.notFound ? (query.data.anchorId ?? null) : null

  // ── Sheet-local actions ──────────────────────────────────────────────────
  const findMessage = useCallback(
    (id: string): Msg | undefined => query.data?.messages?.find((m) => m.id === id),
    [query.data],
  )

  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    const msg = findMessage(messageId)
    if (!msg) return
    const wasMe = msg.reactions?.find((r) => r.emoji === emoji)?.me ?? false
    const nextMe = !wasMe
    // Optimistic — flip immediately on the sheet's own cache.
    queryClient.setQueryData<SheetCache>(queryKey, (c) =>
      toggleSheetReaction(c, messageId, emoji, currentUser.id, nextMe),
    )
    const method = wasMe ? "DELETE" : "PUT"
    const url = `/api/community/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
    apiFetch(url, { method }).catch((e) => {
      queryClient.setQueryData<SheetCache>(queryKey, (c) =>
        toggleSheetReaction(c, messageId, emoji, currentUser.id, wasMe),
      )
      toastApiError(e, "Failed to update reaction")
    })
  }, [queryKey, queryClient, currentUser.id, findMessage])

  const onCopyId = useCallback((id: string) => {
    const m = findMessage(id)
    const content = m ? displayReplyContent(m.content ?? "", m.replyTo) : ""
    if (content) {
      navigator.clipboard?.writeText(content)
      toast("Copied to clipboard")
    }
  }, [findMessage])

  const onReplyId = useCallback((id: string) => {
    if (!onReply) return
    const m = findMessage(id)
    if (!m) return
    onReply({
      id: m.id,
      authorName: m.authorName ?? "",
      text: displayReplyContent(m.content ?? "", m.replyTo),
    })
  }, [findMessage, onReply])

  // Mark works for both channel and DM (unlike pin) — the sheet's channelId is
  // the mark route's channelId for either. `useToggleMark` reads the per-message
  // marked cache (populated when this row's menu opened) to pick POST vs DELETE.
  const onMarkId = useCallback((id: string) => {
    toggleMark(channelId, id)
  }, [toggleMark, channelId])

  const onPinId = useCallback((id: string) => {
    if (type === "dm") return
    const isPinned = pinnedIds?.has(id)
    if (isPinned) {
      unpinMessageMut.mutate({ channelId, messageId: id }, {
        onSuccess: () => toast("Message unpinned"),
        onError: (e) => toastApiError(e, "Failed to unpin message"),
      })
    } else {
      pinMessageMut.mutate({ channelId, messageId: id }, {
        onSuccess: () => toast("Message pinned"),
        onError: (e) => toastApiError(e, "Failed to pin message"),
      })
    }
  }, [type, channelId, pinnedIds, pinMessageMut, unpinMessageMut])

  const onCreateThreadId = useCallback(async (id: string) => {
    if (type === "dm") return
    const serverId = routeParams?.serverId
    if (!serverId) return
    const m = findMessage(id)
    const content = m ? displayReplyContent(m.content ?? "", m.replyTo) : undefined
    const name = deriveThreadName(content, "channel")
    try {
      const data = await createThreadMut.mutateAsync({ serverId, channelId, messageId: id, name })
      // Match the main-channel UX: after creating a thread the row shows
      // the thread indicator, click it to enter. Don't auto-navigate — we're
      // inside a sidecar preview, silently teleporting the user to the thread
      // route surprises them.
      // Patch the sheet's own cache so the indicator appears immediately (the
      // main list's WS handler patches the main cache, but the sheet uses its
      // own query key). Server-authoritative fields land on the actual thread
      // page's fetch; here we only need the shape the row's indicator reads.
      queryClient.setQueryData<SheetCache>(queryKey, (c) => {
        if (!c?.messages) return c
        return {
          ...c,
          messages: c.messages.map((msg) =>
            msg.id === id
              ? { ...msg, thread: { id: data.id, name, messageCount: 0 } }
              : msg,
          ),
        }
      })
    } catch (e) {
      toastApiError(e, "Failed to create thread")
    }
  }, [type, routeParams, channelId, findMessage, createThreadMut, queryClient, queryKey])

  const onOpenThreadId = useCallback((threadId: string) => {
    // Sheet's Reply-style handoff: navigate the main window to the thread and
    // close the sheet in the same gesture. Falls back to a no-op in the DM
    // case (threads live inside channels, not DMs).
    openMessageContextThread({
      type,
      serverId: routeParams?.serverId,
      threadId,
      push: router.push,
      close: () => onOpenChange(false),
    })
  }, [type, router, routeParams, onOpenChange])

  const onPreviewImage = useCallback((image: ImagePreview) => {
    uiHandlers.previewImage?.(image)
  }, [uiHandlers])

  const onPreviewAttachment = useCallback((attachment: FileAttachment) => {
    uiHandlers.previewAttachment?.(attachment)
  }, [uiHandlers])

  const onDownloadFile = useCallback((url: string, name: string) => {
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
  }, [])

  // The sheet's scrollable body — we scroll INSIDE this container, not via
  // `element.scrollIntoView({block:'center'})`. `scrollIntoView` walks up to
  // the nearest scrollable ancestor and, on a first-open where the sheet is
  // still animating in, that ancestor's layout box is mid-translate — the
  // browser then computes a wrong scrollTop. Doing the math ourselves against
  // the body's `getBoundingClientRect()` sidesteps that entirely and works
  // identically on first-open and cache-hit reopen.
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !anchorId) return
    // `targetSeq` in the effect key so re-clicking the SAME pill (open→close→
    // open→same seq) still fires — closing keeps `anchorId` unchanged, so a
    // deps=[open, anchorId] effect would skip the reopen.
    let cancelled = false
    let r2 = 0
    // Two rAFs: first waits for React commit + Base UI popup layout, second
    // waits one paint after that so the popup's translate transition has been
    // ticked at least once and the scroll math resolves against the settled
    // box. Cheap (~32ms) and deterministic across first-open vs reopen.
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        if (cancelled) return
        const body = bodyRef.current
        const row = body?.querySelector<HTMLElement>(`[data-anchor-row="1"]`)
        if (!body || !row) return
        const bodyRect = body.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const targetTop =
          body.scrollTop + (rowRect.top - bodyRect.top) - (bodyRect.height - rowRect.height) / 2
        body.scrollTop = Math.max(0, targetTop)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(r1)
      if (r2) cancelAnimationFrame(r2)
    }
  }, [open, anchorId, targetSeq])

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={channelLabel ? (
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <ChannelIcon className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{channelLabel}</span>
          <span className="shrink-0 font-mono text-base font-normal text-muted-foreground">#{targetSeq ?? ""}</span>
        </span>
      ) : (
        <span className="font-mono text-2xl">
          <span className="text-muted-foreground">#</span>{targetSeq ?? ""}
        </span>
      )}
      bodyRef={bodyRef}
      bodyClassName="px-4 py-3"
    >
      {query.isLoading && <ContextSkeleton />}

      {query.isError && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Couldn&rsquo;t load the message. Check your connection and retry.
        </p>
      )}

      {query.data?.notFound && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Message not found — it may have been deleted.
        </p>
      )}

      {!query.isLoading && !query.isError && query.data && !query.data.notFound && (
        <ContextRows
          rows={renderRows}
          viewerUserId={currentUser.id}
          anchorId={anchorId}
          pinnedIds={pinnedIds}
          onOpenProfile={onOpenProfile}
          onOpenThread={type === "channel" ? onOpenThreadId : undefined}
          resolveUserName={resolveUserName}
          onToggleReaction={toggleReaction}
          onReact={toggleReaction}
          onReply={onReply ? onReplyId : undefined}
          onCopy={onCopyId}
          onPin={type === "channel" ? onPinId : undefined}
          onMark={onMarkId}
          onCreateThread={type === "channel" ? onCreateThreadId : undefined}
          onPreviewImage={onPreviewImage}
          onPreviewAttachment={onPreviewAttachment}
          onDownloadFile={onDownloadFile}
        />
      )}
    </CommunitySheet>
  )
}

function ContextRows({
  rows,
  viewerUserId,
  anchorId,
  pinnedIds,
  onOpenProfile,
  onOpenThread,
  resolveUserName,
  onToggleReaction,
  onReact,
  onReply,
  onCopy,
  onPin,
  onMark,
  onCreateThread,
  onPreviewImage,
  onPreviewAttachment,
  onDownloadFile,
}: {
  rows: RenderMsg[]
  viewerUserId: string
  anchorId: string | null
  pinnedIds?: Set<string>
  onOpenProfile?: OpenProfile
  onOpenThread?: (threadId: string) => void
  resolveUserName?: (userId: string) => string
  onToggleReaction: (id: string, emoji: string) => void
  onReact: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  onCopy: (id: string) => void
  onPin?: (id: string) => void
  onMark?: (id: string) => void
  onCreateThread?: (id: string) => void
  onPreviewImage: (image: ImagePreview) => void
  onPreviewAttachment: (attachment: FileAttachment) => void
  onDownloadFile: (url: string, name: string) => void
}) {
  const hoverCapable = useHoverCapable()
  // Single-message share from the peek sheet. The sheet has no select-mode
  // context (it's a read-only preview), so Share opens the dialog directly on
  // the clicked row — via `onShareSingle`, independent of the list's select-mode
  // plumbing (Cecilia #511: share capability must not depend on it).
  const [shareTarget, setShareTarget] = useState<RenderMsg | null>(null)
  const onShareSingleId = useCallback(
    (id: string) => setShareTarget(rows.find((r) => r.id === id) ?? null),
    [rows],
  )
  return (
    <div className="flex flex-col">
      {shareTarget && (
        <MessageShareDialog m={shareTarget} open onClose={() => setShareTarget(null)} />
      )}
      {rows.map((m, i) => {
        const isTarget = m.id === anchorId
        const prev = i > 0 ? rows[i - 1] : null
        const showDate =
          !prev ||
          (m.createdAt &&
            prev.createdAt &&
            new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString())
        return (
          <div key={m.id}>
            {showDate && m.createdAt && <DateDivider label={formatDateLabel(m.createdAt)} />}
            <div data-anchor-row={isTarget ? "1" : undefined}>
              <MessageRow
                m={m}
                hoverCapable={hoverCapable}
                viewerUserId={viewerUserId}
                pinned={pinnedIds?.has(m.id)}
                highlighted={isTarget}
                onOpenThread={onOpenThread ?? (() => {})}
                onOpenProfile={onOpenProfile}
                onToggleReactionId={onToggleReaction}
                onReactId={onReact}
                onReplyId={onReply}
                onPinId={onPin}
                onMarkId={onMark}
                onCreateThreadId={onCreateThread}
                onCopyId={onCopy}
                onPreviewImage={onPreviewImage}
                onPreviewAttachment={onPreviewAttachment}
                onDownloadFile={onDownloadFile}
                resolveUserName={resolveUserName}
                onShareSingleId={onShareSingleId}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ContextSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3 pt-1.5">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-3 w-14 rounded" />
            </div>
            <Skeleton className="h-3.5 w-full max-w-60 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}
