"use client"

import type React from "react"
import { ChannelPill } from "./inline-marks"
import { useChannelRefTarget, type ChannelRefTargetState } from "@/hooks/community/use-channel-ref-target"
import { useCommunityStore, useUiHandlers } from "@/stores/community"
import { tid } from "@/lib/community/testids"

const STATUS_LABELS: Record<Exclude<ChannelRefTargetState, "ready">, string> = {
  loading: "Loading link…",
  missing: "Link unavailable",
  forbidden: "No access to this channel",
  error: "Couldn’t load link. Click to retry",
}

export function ChannelRefPill({ children }: { children?: React.ReactNode }) {
  const ref = String(children ?? "")
  const currentServerId = useCommunityStore((s) => s.currentServerId)
  const ui = useUiHandlers()
  const resolution = useChannelRefTarget(ref)
  const { target, state, messageSeq } = resolution
  if (!target || state !== "ready") return (
    <ChannelPill muted showIcon={false} state={state} statusLabel={STATUS_LABELS[state === "ready" ? "loading" : state]}
      onClick={state === "error" ? () => { void resolution.retry() } : undefined}>
      {ref}
    </ChannelPill>
  )
  return (
    <ChannelPill
      state="ready"
      serverPrefix={target.server.id !== currentServerId ? target.server.name : undefined}
      onClick={() => {
        const current = resolution.currentTarget()
        if (current) ui.navigate(current.server.id, current.channel.id)
      }}
      seqSuffix={messageSeq}
      testId={tid.channelRefPill(target.channel.id)}
    >
      {target.channel.name}
    </ChannelPill>
  )
}
