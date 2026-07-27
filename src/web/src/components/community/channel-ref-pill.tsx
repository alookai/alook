"use client"

import { useMemo } from "react"
import type React from "react"
import { useRouter } from "next/navigation"
import { ChannelPill } from "./inline-marks"
import { resolveChannelRefBase, type ResolvedChannelRef } from "@/lib/community/channel-ref"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { useCommunityStore } from "@/stores/community"

export type ChannelRefPillView =
  | { kind: "plain"; text: string }
  | { kind: "muted"; label: string }
  | {
    kind: "pill"
    label: string
    serverPrefix?: string
    href: { serverId: string; channelId: string }
  }

/**
 * Pure — takes already-computed inputs, decides what to render. No hooks.
 * This repo has no jsdom/testing-library, so a component that calls
 * `useChannelRefDirectory`/`useCommunityStore`/`useRouter` directly can't be
 * unit-tested the way this function can — mirrors the precedent set by
 * `use-server-members.ts`, which extracts its reducers so hookless logic
 * stays testable and leaves the hook wiring itself untested.
 *
 * Decision table:
 * - `resolved === null` (still loading OR genuinely unresolved) →
 *   `directoryLoading ? "muted" : "plain"` (plain text = `ref`, untouched
 *   fallback — never a broken-looking pill).
 * - `resolved` present → `"pill"`, label = `resolved.channel.name`,
 *   `serverPrefix` set only when the ref points at a different server than
 *   the one currently open.
 */
export function describeChannelRefPillView(args: {
  ref: string
  resolved: ResolvedChannelRef | null
  directoryLoading: boolean
  currentServerId: string | null
}): ChannelRefPillView {
  const { ref, resolved, directoryLoading, currentServerId } = args

  if (!resolved) {
    return directoryLoading ? { kind: "muted", label: ref } : { kind: "plain", text: ref }
  }

  const serverPrefix = resolved.server.id !== currentServerId ? resolved.server.name : undefined

  return {
    kind: "pill",
    label: resolved.channel.name,
    serverPrefix,
    href: { serverId: resolved.server.id, channelId: resolved.channel.id },
  }
}

/**
 * Connected shell — thin. Reads its text content as the raw ref token, calls
 * the hooks, hands everything to `describeChannelRefPillView`, and renders
 * `ChannelPill`/plain text from the returned descriptor.
 */
export function ChannelRefPill({ children }: { children?: React.ReactNode }) {
  const ref = String(children ?? "")
  const router = useRouter()
  const currentServerId = useCommunityStore((s) => s.currentServerId)
  const { directory, isLoading: directoryLoading } = useChannelRefDirectory()

  const resolved = useMemo(() => resolveChannelRefBase(directory, ref), [directory, ref])

  const view = describeChannelRefPillView({
    ref,
    resolved,
    directoryLoading,
    currentServerId,
  })

  if (view.kind === "plain") return <>{view.text}</>
  if (view.kind === "muted") return <ChannelPill muted>{view.label}</ChannelPill>

  return (
    <ChannelPill
      serverPrefix={view.serverPrefix}
      onClick={() => router.push(`/c/channels/${view.href.serverId}/${view.href.channelId}`)}
    >
      {view.label}
    </ChannelPill>
  )
}
