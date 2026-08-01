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
 * Resolve a message-pin token to the target a message-context jump needs —
 * `{ serverId, channelId, label, seq }` (ref/id A2 + #3). A message pin is a
 * channel token whose label carries a `#seq`; the token `id` is the LEAF channel
 * id the message lives in — the channel's own id for a plain-channel message, or
 * the THREAD's own id (`tid`) for a thread message (thread = its own channel,
 * §3.4b). So the jump's channelId is the token `id` DIRECTLY — NOT a directory
 * lookup: a thread's tid is never in `useChannelRefDirectory` (top-level only),
 * so looking it up there would miss. `serverId` still comes from the directory
 * (the server segment IS a top-level entity, always present). `seq` is the
 * message's own seq (`parsed.seq` = the last `#M`; for a thread label
 * `/s/c/#N#M` that's the thread-internal M, the message to land on — NOT the
 * root `#N`, which is only the human-display anchor, see the pill below).
 *
 * Returns null when the label has no seq (a plain channel ref, not a message
 * pin → navigate, don't context-jump) or the server segment isn't in the
 * directory (renamed/no-access) — the pill then stays readable-but-non-navigating
 * rather than a dead jump. READ locating only (opens the context sheet); the id
 * is never turned into a write-addressing axis (Blondie §2.5). Access is enforced
 * server-side by the channel's parent anchor, so a private-parent thread the
 * viewer can't see returns not-found on open — no client-side climb needed.
 */
export function resolveMessageJump(
  label: string,
  id: string,
  directory: ChannelRefDirectory,
): { serverId: string; channelId: string; label: string; seq: number } | null {
  let parsed: ReturnType<typeof parseRef>
  try {
    parsed = parseRef(label)
  } catch {
    return null
  }
  if (parsed.seq === undefined) return null
  const server = directory.find((s) => s.id === parsed.server) ?? directory.find((s) => s.name === parsed.server)
  if (!server) return null
  // channelId = the token's leaf id (tid for a thread, cid for a plain channel) —
  // used directly, not resolved via the directory (thread tids aren't in it).
  // The sheet's display label is the channel leaf from the label (the thread's
  // own name isn't available client-side; the parent/channel leaf reads fine).
  return {
    serverId: server.id,
    channelId: id,
    label: parsed.childChannelName ?? parsed.channel,
    seq: parsed.seq,
  }
}

export type RefTokenPillView =
  | { kind: "channel"; label: string; serverId: string; channelId: string }
  | { kind: "server"; label: string; serverId: string }
  // A message pill shows the channel context + seq (`general #42`) — `label` is
  // the channel leaf, `seq` the message seq. Navigation is wired in RefTokenPill
  // (A2); an unresolved channel (no owning server in the directory) also lands
  // here as a readable, non-navigating pill with `seq: null`.
  | { kind: "message"; label: string; seq: number | null }
  | { kind: "plain"; text: string }

/**
 * Pure view resolver for a `{label}(type/id)` token (ref/id §3). Hybrid: prefer
 * the live name looked up by id in the directory (so a rename reflects
 * automatically); fall back to the stored `label`'s compact leaf when the id
 * can't be resolved (deleted / no access / directory still loading) — never a
 * bare id, never dropped. Leaf/seq/sigil come from the shared `refDisplayParts`
 * (single source with the plaintext preview); the message-vs-plain-channel split
 * is `refDisplayParts`' label-seq inference (there's no `message` token type,
 * ref/id §3.4b). `channelServerId` is the server owning a resolved channel id,
 * needed to navigate.
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
  // Live name (by id, from the directory) wins so a rename reflects. For a
  // message pill the token id is the CHANNEL id (the `()` never held a messageId
  // — §3.4b), so the live name applies to it too; the seq rides the label.
  const shown = liveName ?? parts.leaf
  if (parts.sigilKind === "server") return { kind: "server", label: shown, serverId: id }
  if (parts.sigilKind === "message") return { kind: "message", label: shown, seq: parts.seq }
  // plain channel: navigable only with its owning server; if the id isn't in the
  // directory, degrade to a readable non-navigating pill (message kind, no seq)
  // rather than a dead link.
  if (channelServerId) return { kind: "channel", label: shown, serverId: channelServerId, channelId: id }
  return { kind: "message", label: shown, seq: null }
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

  // A channel token whose label carries a `#seq` is a message pin → resolves to a
  // jump target (open the context sheet on that message) when its channel is in
  // the directory. `resolveMessageJump` returns null for a seqless label or a
  // server token, so it's safe to run for any non-server token.
  const messageJump = useMemo(
    () => (refType === "server" ? null : resolveMessageJump(label, id, directory)),
    [refType, label, id, directory],
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
