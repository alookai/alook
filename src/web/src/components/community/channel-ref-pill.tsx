"use client"

import { useMemo } from "react"
import type React from "react"
import { useRouter } from "next/navigation"
import { ChannelPill } from "./inline-marks"
import { resolveChannelRefBase, type ResolvedChannelRef } from "@/lib/community/channel-ref"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { useThreads } from "@/hooks/community/use-channel-panels"
import { useCommunityStore, useUiHandlers } from "@/stores/community"

export type ChannelRefPillView =
  | { kind: "plain"; text: string }
  | { kind: "muted"; label: string }
  | {
    kind: "pill"
    label: string
    serverPrefix?: string
    href: { serverId: string; channelId: string }
    // Set only in the "thread ref resolved to a channel but not a matching
    // thread" degrade case — the caller renders this as plain text right
    // after the pill, since a `/#N` suffix is never part of the clickable
    // target (see decision table below).
    threadSuffix?: number
    // Set when the ref pins a specific message inside a thread
    // (`/s/c/#N#M`, see plans/agent-thread-emoji-react.md). Rendered as
    // plain trailing text (`#M`, no leading slash) — the clickable target
    // is still the thread channel; `#M` is a visible cursor, not a deep
    // link anchor.
    messageSuffix?: number
  }

/**
 * Pure — takes already-computed inputs, decides what to render. No hooks.
 * This repo has no jsdom/testing-library, so a component that calls
 * `useChannelRefDirectory`/`useThreads`/`useCommunityStore`/`useRouter`
 * directly can't be unit-tested the way this function can — mirrors the
 * precedent set by `use-server-members.ts`, which extracts its reducers so
 * hookless logic stays testable and leaves the hook wiring itself untested.
 *
 * Decision table:
 * - `resolved === null` (still loading OR genuinely unresolved) →
 *   `directoryLoading ? "muted" : "plain"` (plain text = `ref`, untouched
 *   fallback — never a broken-looking pill).
 * - `resolved` present, no `threadRootSeq` → `"pill"`, label =
 *   `resolved.channel.name`, `serverPrefix` set only when the ref points at
 *   a different server than the one currently open.
 * - `resolved` present, `threadRootSeq` set:
 *   - `thread === undefined` (still loading) → `"muted"` (base channel label).
 *   - `thread` found (`parentSeq` match) → `"pill"` targeting the thread id,
 *     label = thread name.
 *   - `thread === null` (loaded, no match) → `"pill"` targeting the base
 *     channel — graceful degrade. The caller is responsible for appending
 *     the literal `/#{threadRootSeq}` as separate plain trailing text next
 *     to the pill, since that suffix is never part of the clickable target.
 */
export function describeChannelRefPillView(args: {
  ref: string
  resolved: ResolvedChannelRef | null
  directoryLoading: boolean
  thread: { id: string; name: string; parentSeq?: number } | null | undefined
  currentServerId: string | null
}): ChannelRefPillView {
  const { ref, resolved, directoryLoading, thread, currentServerId } = args

  if (!resolved) {
    return directoryLoading ? { kind: "muted", label: ref } : { kind: "plain", text: ref }
  }

  const serverPrefix = resolved.server.id !== currentServerId ? resolved.server.name : undefined

  if (resolved.threadRootSeq === undefined) {
    return {
      kind: "pill",
      label: resolved.channel.name,
      serverPrefix,
      href: { serverId: resolved.server.id, channelId: resolved.channel.id },
      // A channel-MESSAGE ref (`/server/channel#N`, message-ref-upgrade.md):
      // the clickable target is the channel; `#N` renders as a trailing cursor,
      // exactly like a thread-message ref's `#M` below. (Auto-scroll to the seq
      // cross-channel would need seq→id deep-link infra the app doesn't have —
      // `?msg=` anchors by id — so it's a plain cursor, matching the thread case.)
      ...(resolved.seq !== undefined ? { messageSuffix: resolved.seq } : {}),
    }
  }

  if (thread === undefined) {
    return { kind: "muted", label: resolved.channel.name }
  }

  if (thread === null) {
    return {
      kind: "pill",
      label: resolved.channel.name,
      serverPrefix,
      href: { serverId: resolved.server.id, channelId: resolved.channel.id },
      threadSuffix: resolved.threadRootSeq,
      ...(resolved.seq !== undefined ? { messageSuffix: resolved.seq } : {}),
    }
  }

  return {
    kind: "pill",
    label: thread.name,
    serverPrefix,
    href: { serverId: resolved.server.id, channelId: thread.id },
    ...(resolved.seq !== undefined ? { messageSuffix: resolved.seq } : {}),
  }
}

/**
 * Connected shell — thin. Reads its text content as the raw ref, calls the
 * hooks, hands everything to `describeChannelRefPillView`, and renders
 * `ChannelPill`/plain text from the returned descriptor.
 *
 * Hook-call rule (not negotiable — a common Rules of Hooks trap):
 * `useThreads` is called UNCONDITIONALLY on every render, relying on the
 * hook's own `enabled: !!channelId` gate for the "don't fetch" case — never
 * wrap the `useThreads(...)` call itself in an `if`/early-return.
 */
export function ChannelRefPill({ children }: { children?: React.ReactNode }) {
  const ref = String(children ?? "")
  const router = useRouter()
  const currentServerId = useCommunityStore((s) => s.currentServerId)
  const currentChannelId = useCommunityStore((s) => s.currentChannelId)
  const uiHandlers = useUiHandlers()
  const { directory, isLoading: directoryLoading } = useChannelRefDirectory()

  // The debt record's own verification (see finding #6) confirmed the
  // network requests behind `useChannelRefDirectory`/`useThreads` already
  // dedupe via the shared TanStack Query cache — the one verified real cost
  // was this directory scan running unmemoized on every render.
  const resolved = useMemo(() => resolveChannelRefBase(directory, ref), [directory, ref])

  const threadChannelId = resolved?.threadRootSeq !== undefined ? resolved.channel.id : null
  const { threads, isLoading: threadsLoading } = useThreads(threadChannelId)
  const thread = !threadChannelId
    ? null
    : threadsLoading
      ? undefined
      : threads.find((t) => t.parentSeq === resolved?.threadRootSeq) ?? null

  const view = describeChannelRefPillView({
    ref,
    resolved,
    directoryLoading,
    thread,
    currentServerId,
  })

  if (view.kind === "plain") return <>{view.text}</>
  if (view.kind === "muted") return <ChannelPill muted>{view.label}</ChannelPill>

  // A message ref (`#N` suffix) whose target is the ALREADY-OPEN channel should
  // SCROLL to the message, not navigate (navigating to the current channel is a
  // no-op that leaves the viewport put — the same-channel regression from
  // dropping the bare-`#N` pill). Route through the `jumpToSeq` UI-handler the
  // page registers (message loaded → scroll; else context sheet resolves
  // seq→id). Cross-channel refs still `router.push`; scroll-after-navigate is a
  // separate followup (see message-ref-upgrade.md).
  const sameChannelSeq =
    view.messageSuffix !== undefined && view.href.channelId === currentChannelId
      ? view.messageSuffix
      : undefined
  const onClick = sameChannelSeq !== undefined
    ? () => uiHandlers.jumpToSeq?.(sameChannelSeq)
    : () => router.push(`/c/channels/${view.href.serverId}/${view.href.channelId}`)

  return (
    <>
      <ChannelPill serverPrefix={view.serverPrefix} onClick={onClick} seqSuffix={view.messageSuffix}>
        {view.label}
      </ChannelPill>
      {/* The `/#N` thread-root suffix stays a detached plain span — it names the
          thread the pill degraded to (no matching thread found), not the pill's
          own target. The message `#N` (view.messageSuffix), by contrast, IS the
          target, so it's rendered INSIDE the pill via `seqSuffix` above. */}
      {view.threadSuffix !== undefined && <span className="text-muted-foreground">/#{view.threadSuffix}</span>}
    </>
  )
}
