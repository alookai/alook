import type React from "react"
import { Spoiler, MentionPill } from "./inline-marks"
import { ChannelRefPill } from "./channel-ref-pill"
import { ServerRefPill } from "./server-ref-pill"

// Match `/c/invite/<token>` — with or without an origin.
// - token allows [A-Za-z0-9_-] (nanoid alphabet) and length 6..64 (short + old
//   32-char tokens both fit)
// - unrelated to chat-only syntax (mention/spoiler/channelRef, now parsed as
//   real markdown AST nodes by `chat-syntax-plugin.ts`/`spoiler-syntax.ts`) —
//   this regex only extracts invite tokens for the join-card row rendered
//   below the message body; the URL text itself stays untouched and is
//   auto-linked by Streamdown/GFM.
const INVITE_URL_RE = /(https?:\/\/[^\s/]+)?\/c\/invite\/([A-Za-z0-9_-]{6,64})/g

/**
 * Extract every invite token in a message body (URL text stays as-is, cards
 * render *below* the message). Returns the tokens in
 * discovery order, deduped so a friend spamming the same link doesn't stack
 * duplicate cards.
 */
export function extractInviteTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // A resettable non-global copy avoids inheriting `lastIndex` between calls.
  const re = new RegExp(INVITE_URL_RE.source, "g")
  for (const m of text.matchAll(re)) {
    const token = m[2]
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

export const MD_ALLOWED_TAGS = {
  spoiler: [],
  mention: ["data-everyone", "data-tag"],
  channelref: [],
  serverref: [],
}
// `spoiler` is deliberately excluded — unlike `mention`/`channelref`/`serverref`
// (leaf nodes whose content is always plain tag text), a spoiler must keep its
// nested markdown children (e.g. `||**bold**||`). Handing it to Streamdown's
// `literalTagContent` flattens all descendants into one text node, stripping
// the nested `<strong>`/`<em>` — see message-body.test.tsx's regression case.
export const MD_LITERAL_TAGS = ["mention", "channelref", "serverref"]

// A mention pill's rendered text is always `@name` (produced by
// `chat-syntax-plugin.ts`'s `mentionReplacer`, which already drops the
// `#0042` discriminator) — this strips the leading `@` and, defensively, any
// trailing `#dddd` that slips through another path, so the result matches
// `Member.name`/`Msg.authorName` for the profile-card lookup in
// shell-frame.tsx's `openProfile`. Exported for tests.
export function mentionNameFromText(text: string): string {
  return text.replace(/^@/, "").replace(/#\d{4}$/, "")
}

export const MD_COMPONENTS = {
  spoiler: ({ children }: { children?: React.ReactNode }) => <Spoiler>{children}</Spoiler>,
  mention: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <MentionPill everyone={rest["data-everyone"] === "1"}>{children}</MentionPill>
  ),
  // `channelref`/`serverref` are fully self-sufficient via hooks (resolve via
  // `useChannelRefDirectory`, navigate via `useRouter`) — unlike `mention`,
  // they need no closure injected by `buildMdComponents`, so the same static
  // entries are reused there too (see the spread below).
  channelref: ChannelRefPill,
  serverref: ServerRefPill,
} as Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>>

// Same as `MD_COMPONENTS`, but the `mention` pill opens the profile card on
// click (skipped for @everyone/@here — there's no user behind those). Built
// per-render (memoized by the caller) rather than statically, since it
// closes over `onOpenProfile`.
export function buildMdComponents(
  onOpenProfile?: (name: string, e: React.MouseEvent, discriminator?: string) => void,
): Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>> {
  return {
    ...MD_COMPONENTS,
    mention: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => {
      const everyone = rest["data-everyone"] === "1"
      const name = mentionNameFromText(String(children ?? ""))
      const tag = rest["data-tag"]
      const discriminator = typeof tag === "string" ? tag : undefined
      return (
        <MentionPill
          everyone={everyone}
          onClick={!everyone && onOpenProfile ? (e) => onOpenProfile(name, e, discriminator) : undefined}
        >
          {children}
        </MentionPill>
      )
    },
  }
}
