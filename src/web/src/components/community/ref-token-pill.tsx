"use client"

import { useMemo } from "react"
import type React from "react"
import { ChannelPill, ServerPill } from "./inline-marks"
import { useChannelRefDirectory } from "@/hooks/community/use-channel-ref-directory"
import { useUiHandlers } from "@/stores/community"
import type { RefTokenType } from "@/lib/community/ref-token"
// The leaf/seq/sigil logic is the shared single source (`refDisplayParts`), so
// this rich pill and the plaintext preview (`formatRefLabel`/`stripRefTokens`)
// can't drift (ref/id A1). `compactLabel` re-exported so this module's existing
// import surface (+ its test) is unchanged.
import { compactLabel, refDisplayParts, parseRef } from "@alook/shared/community-cli-contract"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
export { compactLabel }

/**
 * Resolve a message token's `data-label` (`/server/channel#seq`) to the target a
 * message-context jump needs — `{ serverId, channelId, label, seq }` — by parsing
 * the label with the shared ref parser (one ruler, not a hand-split) and looking
 * the server/channel NAMES up in the already-loaded directory (ref/id A2).
 * Returns null when the label lacks a seq, doesn't parse, is a thread-message,
 * or the server/channel isn't in the directory (deleted / no access / DM) — the
 * pill then stays readable-but-non-navigating rather than offering a dead or
 * WRONG jump. This is READ locating (open the context sheet), never a
 * write-addressing path — the leaf messageId is not turned into a new addressing
 * axis (Blondie §2.5).
 *
 * Thread-message guard (`/s/c/#root#seq`): a thread is its own channel with its
 * own seq space, and the directory only holds top-level channels — so `seq` here
 * would be resolved against the PARENT channel `c` and jump to the wrong message.
 * The directory can't supply the thread's channelId, so we can't jump correctly;
 * return null (readable, non-navigating) rather than jump wrong. Unreachable
 * today (no producer emits a thread-message token — the composer only emits
 * channel tokens), but guarding it keeps the resolver honest (Ingaborg #337).
 */
export function resolveMessageJump(
  label: string,
  directory: ChannelRefDirectory,
): { serverId: string; channelId: string; label: string; seq: number } | null {
  let parsed: ReturnType<typeof parseRef>
  try {
    parsed = parseRef(label)
  } catch {
    return null
  }
  if (parsed.seq === undefined) return null
  // A thread-message (`threadRootSeq` present) can't be located via the top-level
  // directory — see the thread-message guard note above.
  if (parsed.threadRootSeq !== undefined) return null
  const server = directory.find((s) => s.id === parsed.server) ?? directory.find((s) => s.name === parsed.server)
  if (!server) return null
  const channel =
    server.channels.find((c) => c.id === parsed.channel) ??
    server.channels.find((c) => c.name === parsed.channel)
  if (!channel) return null
  return { serverId: server.id, channelId: channel.id, label: channel.name, seq: parsed.seq }
}

export type RefTokenPillView =
  | { kind: "channel"; label: string; serverId: string; channelId: string }
  | { kind: "server"; label: string; serverId: string }
  // A message pill shows the channel context + seq (`general #42`) — `label` is
  // the channel leaf, `seq` the message seq (null if the label lacked one). No
  // navigation yet (A2 wires the click); a channel that can't resolve its
  // owning server also lands here as a readable, non-navigating pill.
  | { kind: "message"; label: string; seq: number | null }
  | { kind: "plain"; text: string }

/**
 * Pure view resolver for a `{label}(type/id)` token (ref/id §3). Hybrid: prefer
 * the live name looked up by id in the directory (so a rename reflects
 * automatically); fall back to the stored `label`'s compact leaf when the id
 * can't be resolved (deleted / no access / directory still loading) — never a
 * bare id, never dropped. Leaf/seq/sigil come from the shared `refDisplayParts`
 * (single source with the plaintext preview). `channelServerId` is the server
 * owning a resolved channel id, needed to navigate.
 */
export function describeRefTokenPillView(args: {
  refType: RefTokenType
  id: string
  label: string
  liveName: string | null
  channelServerId: string | null
}): RefTokenPillView {
  const { refType, id, label, liveName, channelServerId } = args
  const parts = refDisplayParts(refType, label)
  // Live name (by id, from the directory) wins for channel/server so a rename
  // reflects; a message token carries a leaf messageId, not a channel id, so its
  // channel name comes from the parsed label leaf (no live lookup for it here).
  const shown = liveName ?? parts.leaf
  if (refType === "server") return { kind: "server", label: shown, serverId: id }
  if (refType === "channel") {
    // Can only navigate a channel with its owning server; if the id isn't in
    // the directory we still render a (non-navigating) readable pill via the
    // message branch's plain-label path rather than a dead link.
    if (channelServerId) return { kind: "channel", label: shown, serverId: channelServerId, channelId: id }
    return { kind: "message", label: shown, seq: null }
  }
  // message: readable pill with the channel leaf + seq (`general #42`). The click
  // wiring (jump to that message) is A2; today it's non-navigating.
  return { kind: "message", label: parts.sigilKind === "message" ? parts.leaf : shown, seq: parts.sigilKind === "message" ? parts.seq : null }
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

  // A message token resolves to a jump target (open the context sheet on that
  // message) when its channel is in the directory and the label carries a seq.
  const messageJump = useMemo(
    () => (refType === "message" ? resolveMessageJump(label, directory) : null),
    [refType, label, directory],
  )

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
  // message: `general #42` via `seqSuffix`. Clickable → open the message-context
  // sheet on that message (ref/id A2), IF the channel resolved and there's a seq;
  // otherwise (unresolved channel, or a channel token that couldn't find its
  // server) it stays a readable, non-navigating pill.
  return (
    <ChannelPill
      seqSuffix={view.seq ?? undefined}
      onClick={messageJump ? () => uiHandlers.openMessageContext?.(messageJump) : undefined}
    >
      {view.label}
    </ChannelPill>
  )
}
