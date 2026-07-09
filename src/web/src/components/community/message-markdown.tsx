import type React from "react"
import { Spoiler, MentionPill } from "./inline-marks"
import { ChannelRefPill } from "./channel-ref-pill"

// Match a `/server/channel` or `/server/channel/#N` (thread) ref — the CLI's
// path grammar (`parseRef`/`formatRef` in `community-cli-contract.ts`). Segment
// charset `[A-Za-z0-9_-]+` is the nanoid alphabet every `communityServer.id`/
// `communityChannel.id` is generated with, so a compact ref must be built from
// ids (see `channel-ref-extension.ts`'s `renderText`) — display names with
// spaces/punctuation can't round-trip through this regex (same limitation the
// legacy `#channel-name` chip had). The pinned-message form (`#N` directly, no
// slash) is intentionally not matched — see plan §1 for why.
//
// Trailing `(?=\s|$|[.,;:!?)\]])` boundary lookahead: a 2-segment path
// followed by ANOTHER `/segment` (e.g. `/api/user/123` in a docs URL) must
// NOT match — otherwise CHANNEL_REF_REGEX greedily takes `/api/user` and
// orphans `/123` as trailing text next to a broken pill. Requiring a
// terminator forces the match to sit ONLY on a real leaf ref.
const CHANNEL_REF_REGEX = /(^|\s)(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/#\d+)?)(?=\s|$|[.,;:!?)\]])/g

// Sentinels for stashing code spans/fences (private-use chars — won't collide with
// real text or markdown punctuation).
const S0 = "\u{E000}"
const S1 = "\u{E001}"

// Match `/community/invite/<token>` — with or without an origin.
// - token allows [A-Za-z0-9_-] (nanoid alphabet) and length 6..64 (short + old
//   32-char tokens both fit)
// - the URL matcher is applied AFTER code fences/spans are stashed, so links
//   inside code stay literal
const INVITE_URL_RE = /(https?:\/\/[^\s/]+)?\/community\/invite\/([A-Za-z0-9_-]{6,64})/g

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

// Neutralize only `<` (and `&`) so user text can't inject our custom tags or raw HTML.
// `>` is left intact so markdown blockquote syntax (`> quote`) still works — a lone `>`
// with no matching `<` can't form a tag.
export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;")

/**
 * Turn chat-only syntax (spoilers, @mentions, @everyone/@here, #channels) into
 * custom tags streamdown preserves and hands to `components`. Code spans/fences are
 * stashed first so `@`/`#`/`||` inside code stay literal. Pure — exported for tests.
 */
export function preprocessMarkdown(text: string): string {
  const stash: string[] = []
  const protect = (m: string) => `${S0}${stash.push(m) - 1}${S1}`
  let out = text
    .replace(/```[\s\S]*?```/g, protect) // fenced code
    .replace(/`[^`\n]*`/g, protect) // inline code
  // Stash invite-link URLs BEFORE `CHANNEL_REF_REGEX` runs — `/community/invite/<token>`
  // shape-matches the channel-ref regex too (server="community", channel="invite"),
  // which would otherwise wrap `/community/invite` in a `<channelref>` tag and
  // leave the token as a disconnected trailing text node, breaking streamdown's
  // GFM autolinking of the whole URL. A fresh (non-shared) regex copy avoids
  // inheriting `lastIndex` from `INVITE_URL_RE`/other callers.
  out = out.replace(new RegExp(INVITE_URL_RE.source, "g"), protect)
  out = out
    // CommonMark needs a blank line before a blockquote; chat-style quotes are line-by-line.
    // Insert one so a `> ` that immediately follows text still renders as a quote.
    .replace(/([^\n])\n(> )/g, "$1\n\n$2")
    .replace(/\|\|([\s\S]+?)\|\|/g, (_m, c) => `<spoiler>${c}</spoiler>`)
    // single mention pass so @everyone/@here aren't re-matched inside the tag just inserted.
    // Optional `#0042` discriminator suffix (global handle format) — the
    // `(?!\d)` lookahead stops a 5+-digit run from being truncated into a
    // false-positive handle (e.g. `@Gus#00423` wraps only `@Gus`). The
    // discriminator is consumed here (so it never leaks as unstyled trailing
    // text) and stashed in a `data-tag` attribute, but dropped from the tag's
    // visible *content* — humans only ever see `@name`. Carrying it as a data
    // attribute (rather than discarding it outright) lets a click handler
    // resolve the exact same-named member instead of the first name match
    // (see `buildMdComponents`/`shell-frame.tsx`'s `openProfile`).
    .replace(/@[\w-]+(?:#\d{4}(?!\d))?/g, (m) => {
      if (m === "@everyone" || m === "@here") return `<mention data-everyone="1">${m}</mention>`
      const tagMatch = /#(\d{4})$/.exec(m)
      const bare = m.replace(/#\d{4}$/, "")
      return tagMatch ? `<mention data-tag="${tagMatch[1]}">${bare}</mention>` : `<mention>${bare}</mention>`
    })
    // `/server/channel` refs (see `CHANNEL_REF_REGEX`'s doc comment). Leading
    // boundary `(^|\s)` kept outside the tag, same convention the old
    // `#channel` step used — `" /channel-ref"` matches, `"text/channel-ref"`
    // doesn't. The tag's content is fed straight into `@alook/shared`'s
    // `parseRef` at render time (`channel-ref-pill.tsx`), reusing the exact
    // grammar the backend already uses.
    .replace(CHANNEL_REF_REGEX, (_m, pre, ref) => `${pre}<channelref>${ref}</channelref>`)
  return out.replace(new RegExp(`${S0}(\\d+)${S1}`, "g"), (_m, i) => stash[Number(i)])
}

export const MD_ALLOWED_TAGS = {
  spoiler: [],
  mention: ["data-everyone", "data-tag"],
  channelref: [],
}
export const MD_LITERAL_TAGS = ["spoiler", "mention", "channelref"]

// A mention pill's rendered text is always `@name` (see `preprocessMarkdown`,
// which already drops the `#0042` discriminator) — this strips the leading
// `@` and, defensively, any trailing `#dddd` that slips through another path,
// so the result matches `Member.name`/`Msg.authorName` for the profile-card
// lookup in shell-frame.tsx's `openProfile`. Exported for tests.
export function mentionNameFromText(text: string): string {
  return text.replace(/^@/, "").replace(/#\d{4}$/, "")
}

export const MD_COMPONENTS = {
  spoiler: ({ children }: { children?: React.ReactNode }) => <Spoiler>{children}</Spoiler>,
  mention: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <MentionPill everyone={rest["data-everyone"] === "1"}>{children}</MentionPill>
  ),
  // `channelref` is fully self-sufficient via hooks (resolves via
  // `useChannelRefDirectory`, navigates via `useRouter`) — unlike `mention`,
  // it needs no closure injected by `buildMdComponents`, so the same static
  // entry is reused there too (see the spread below).
  channelref: ChannelRefPill,
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
