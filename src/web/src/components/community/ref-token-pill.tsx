"use client"

import { useMemo } from "react"
import type React from "react"
import { ChannelPill, ServerPill } from "./inline-marks"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { useUiHandlers } from "@/stores/community"
import type { RefTokenType } from "@/lib/community/ref-token"
// `compactLabel` is now the shared single source (also used by the plaintext
// preview formatter `stripRefTokens`, ref/id PR-9). Re-exported here so this
// module's existing `compactLabel` import surface (+ its test) is unchanged.
import { compactLabel } from "@alook/shared/community-cli-contract"
export { compactLabel }

export type RefTokenPillView =
  | { kind: "channel"; label: string; serverId: string; channelId: string }
  | { kind: "server"; label: string; serverId: string }
  | { kind: "message"; label: string }
  | { kind: "plain"; text: string }

/**
 * Pure view resolver for a `{label}(type/id)` token (ref/id §3). Hybrid: prefer
 * the live name looked up by id in the directory (so a rename reflects
 * automatically); fall back to the stored `label` when the id can't be resolved
 * (deleted / no access / directory still loading) — never a bare id, never
 * dropped. `channelServerId` is the server owning a resolved channel id, needed
 * to navigate.
 */
export function describeRefTokenPillView(args: {
  refType: RefTokenType
  id: string
  label: string
  liveName: string | null
  channelServerId: string | null
}): RefTokenPillView {
  const { refType, id, label, liveName, channelServerId } = args
  const shown = liveName ?? compactLabel(label)
  if (refType === "server") return { kind: "server", label: shown, serverId: id }
  if (refType === "channel") {
    // Can only navigate a channel with its owning server; if the id isn't in
    // the directory we still render a (non-navigating) readable pill via the
    // message branch's plain-label path rather than a dead link.
    if (channelServerId) return { kind: "channel", label: shown, serverId: channelServerId, channelId: id }
    return { kind: "message", label: shown }
  }
  // message: the token carries only a leaf messageId (no channelId+seq), which
  // the current context-sheet navigation can't consume — render a readable,
  // non-navigating pill from the label for now. (Message-jump wiring by leaf id
  // is a follow-up; flagged in the PR.)
  return { kind: "message", label: shown }
}

/**
 * Connected `{label}(type/id)` pill. Reads the token's type/id/label from the
 * `data-*` props the mdast handler set (`chat-syntax-plugin.ts`), resolves the
 * live name via the shared `useChannelRefDirectory` (same source the legacy
 * channel/server pills use — one directory, no divergent resolution), and
 * navigates via the `navigate` UI-handler (the memoized message tree's local
 * router is a no-op — same pattern as ChannelRefPill/ServerRefPill).
 */
export function RefTokenPill(
  props: Record<string, unknown> & { children?: React.ReactNode },
) {
  const refType = String(props["data-type"] ?? "") as RefTokenType
  const id = String(props["data-id"] ?? "")
  const label = String(props["data-label"] ?? props.children ?? "")
  const uiHandlers = useUiHandlers()
  const { directory } = useChannelRefDirectory()

  const { liveName, channelServerId } = useMemo(() => {
    if (refType === "server") {
      const s = directory.find((d) => d.id === id)
      return { liveName: s?.name ?? null, channelServerId: null }
    }
    if (refType === "channel") {
      for (const s of directory) {
        const ch = s.channels.find((c) => c.id === id)
        if (ch) return { liveName: ch.name, channelServerId: s.id }
      }
    }
    return { liveName: null, channelServerId: null }
  }, [directory, refType, id])

  const view = describeRefTokenPillView({ refType, id, label, liveName, channelServerId })

  if (view.kind === "plain") return <>{view.text}</>
  if (view.kind === "server") {
    return <ServerPill onClick={() => uiHandlers.navigate?.(view.serverId)}>{view.label}</ServerPill>
  }
  if (view.kind === "channel") {
    return (
      <ChannelPill onClick={() => uiHandlers.navigate?.(view.serverId, view.channelId)}>
        {view.label}
      </ChannelPill>
    )
  }
  // message (or an unresolved channel): readable pill, no navigation.
  return <ChannelPill>{view.label}</ChannelPill>
}
