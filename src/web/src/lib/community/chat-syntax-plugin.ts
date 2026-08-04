import type { Root, PhrasingContent } from "mdast"
import { findAndReplace } from "mdast-util-find-and-replace"
import type { Handler, Handlers } from "mdast-util-to-hast"
import type { Element } from "hast"
import type { Plugin } from "unified"
import { spoilerSyntax, spoilerFromMarkdown } from "./spoiler-syntax"
import type { SpoilerNode } from "./spoiler-syntax"

// Chat-only syntax (`||spoiler||`, `@mention`, `/server/channel` and bare
// `/server` refs), parsed as real markdown AST nodes rather than
// string-spliced HTML tags fed through `rehype-raw`. `channelRef`/`serverRef`
// content is a nanoid charset (`[A-Za-z0-9_-]`); a member `mention` is
// `@<name>#dddd` where the name may contain spaces but never a markdown
// metacharacter (validateCommunityName forbids `#`/`@`/line breaks, and the
// composer only ever inserts names picked from the roster), so a
// `mdast-util-find-and-replace` pass stays safe — `remark-parse` won't split
// these tokens across sibling text nodes. `spoiler` is handled separately by
// the micromark tokenizer extension in `spoiler-syntax.ts` — see that file's
// comment for why find-and-replace cannot handle spoilers containing nested
// formatting.

// Mirrors `CHANNEL_REF_REGEX`'s old doc comment: matches a `/server/channel`,
// `/server/channel/#N` (thread), or `/server/channel/#N#M` (thread reply,
// see plans/agent-thread-emoji-react.md) ref — the CLI's path grammar
// (`parseRef`/`formatRef` in `community-cli-contract.ts`). Segment charset
// `[^\s/#.,;:!?)\]]+` = "any char slugify can emit, minus the terminator
// punctuation": server/channel names travel on the wire as their SLUGIFIED
// DISPLAY NAME, not an id (see the round-trip contract in
// `channel-ref-extension.ts`'s `renderText` doc + `slugify.ts`), and slugify
// preserves Unicode — it strips only `/` and `#` and collapses whitespace. So
// the base of the class is the inverse of what slugify removes (everything
// except whitespace, `/`, `#`), which is what lets non-ASCII names
// (`/Gus/架构`, `/总部-🎉/general`, `/studio/café`) render as pills like their
// ASCII kin — matching the `\p{L}` + `u` treatment `MENTION_RE` already uses
// for `@names`. We ALSO exclude the trailing-boundary punctuation (`REF_TERM`
// below) from the segment class: the old ASCII class `[A-Za-z0-9_-]` happened
// to be disjoint from the terminator set, and that disjointness is
// load-bearing — the segment class `[^\s/#…]+` is GREEDY, so without excluding
// a terminator char from the segment it gets eaten BEFORE the lookahead can
// fire (a greedy segment swallows the sentence period in `/studio/general.`;
// same for the full-width `。` in `看 /Gus/架构。`). So a terminator must live
// in BOTH places: excluded from the segment (so the match stops there) AND
// present in the lookahead (so stopping there is legal). slugify never emits a
// leading/trailing terminator anyway, and a mid-name terminator is a rare
// corner that degrading to plain text is acceptable for; keeping the boundary
// correct for ALL refs matters more.
//
// `REF_TERM` is the single source of truth for the terminator set — used BOTH
// as the segment-class exclusion (`REF_SEG`) and the trailing lookahead, so
// the two can't drift out of the disjointness the boundary relies on. It
// covers ASCII `.,;:!?)]` AND the common FULL-WIDTH CJK sentence punctuation
// `。！？；：、）】`: a Chinese sentence ends in `。`, so `看 /Gus/架构。` must
// yield pill `/Gus/架构` + literal `。`, not swallow the period — full-width
// terminators matter MORE here since this fix targets CJK names (Blair's QA
// flag). Kept as a string spliced into `new RegExp(...)` so the shared set is
// declared once.
//
// Trailing `(?=\s|$|[REF_TERM])` boundary lookahead: a 2-segment path followed
// by ANOTHER `/segment` (e.g. `/api/user/123` in a docs URL) must NOT match —
// otherwise this regex would greedily take `/api/user` and orphan `/123` as
// trailing text next to a broken pill. Leading `(?<=^|\s)` lookbehind
// (verified empirically — a bare leading `\/` with no lookbehind would let
// this match START mid-path, e.g. matching `/user/123` inside
// `/api/user/123`): `" /channel-ref"` matches, `"text/channel-ref"` doesn't.
// Both boundaries are zero-width lookaround (not capture groups) so
// `findAndReplace` doesn't need to redistribute a leading/trailing text node
// around the match the way the old string-splice regex's `(^|\s)` capture
// group did. `u` flag for correct astral/emoji handling.
const REF_TERM = ".,;:!?)\\]\\u3002\\uFF01\\uFF1F\\uFF1B\\uFF1A\\u3001\\uFF09\\u3011"
const REF_SEG = `[^\\s/#${REF_TERM}]+`
// `/server/channel` plus an optional message/thread suffix. The suffix has two
// branches (message-ref-upgrade.md):
//   `#\d+`            — a channel-MESSAGE ref, seq glued straight to the channel
//                       (`/server/channel#N`). Single seq ONLY — `#N#M` without a
//                       slash is not a valid form (Cecilia #295, load-bearing).
//   `/#\d+(?:#\d+)?`  — a THREAD (`/server/channel/#N`) or thread-message
//                       (`/server/channel/#N#M`) ref; the inner `#M` lives only
//                       on this slash branch.
// `REF_SEG` excludes `#`, so the 2nd segment stops at the `#` and the seq falls
// cleanly into the suffix group. The leading `(?<=^|\s)` prefix-anchor means this
// only ever matches a full path — never a bare `#` — which is what lets us drop
// the old bare-`#N` MESSAGE_REF pass and root-solve the disambiguation Gus flagged.
const CHANNEL_REF_RE = new RegExp(`(?<=^|\\s)/${REF_SEG}/${REF_SEG}(?:#\\d+|/#\\d+(?:#\\d+)?)?(?=\\s|$|[${REF_TERM}])`, "gu")

// A bare `/server` ref — one segment, no channel. Same boundary lookaround as
// `CHANNEL_REF_RE` (leading `(?<=^|\s)`, trailing `REF_TERM`), which already
// excludes being followed by another `/segment` — so this never double-matches
// the first segment of a genuine `/server/channel` ref (that trailing boundary
// fails when the next char is `/`, and the segment class backtracking can't
// produce a shorter match that satisfies it either, since every character up
// to the next `/` is in the segment charset). Same `REF_SEG`/`REF_TERM` +
// `u` flag as `CHANNEL_REF_RE` above (Unicode server names, full-width
// terminators). Registered after `CHANNEL_REF_RE` in `chatSyntaxPlugin`'s
// pairs list purely for readability (server-only is the "smaller" grammar);
// the boundary already makes the ordering non-load-bearing for correctness.
const SERVER_REF_RE = new RegExp(`(?<=^|\\s)/${REF_SEG}(?=\\s|$|[${REF_TERM}])`, "gu")

// (The old bare-`#N` MESSAGE_REF_RE was removed in message-ref-upgrade.md — a
// message ref is now always the full path `/server/channel#N`, matched by
// CHANNEL_REF_RE's suffix group above. A bare `#N` now renders as plain text.
// This kills the fragile "works only because it's the last consumption pass"
// disambiguation: the prefix-anchored full-path form can't collide with a bare
// `#`, so no ordering hazard with mentions/spoilers/other `#` syntax.)

// Two-branch mention grammar (see plans/mandatory-mention-discriminator.md):
//
//  1. The literal `@everyone` token, with a trailing `(?![\p{L}\p{N}_-])`
//     boundary guard so `@everyoneee` is NOT matched as `@everyone` — this MUST
//     agree with `detectMentionType`'s boundary check (mention-extension.ts)
//     and `community-mentions.ts`'s `ID_CHAR_RE`. (`@here` was removed as a
//     broadcast trigger — see plans/remove-here-mention.md; a literal `@here`
//     now falls through as ordinary text, matching option b: no legacy
//     rendering for historical `@here`.)
//
//  2. A member mention `@<name>#dddd` where the trailing `#dddd` is REQUIRED
//     and acts as an unambiguous terminator. Because member names are validated
//     to never contain `#`, `@`, or line breaks (validateCommunityName), the
//     name-run may safely include spaces/unicode: `[^@#\n\r]*[^@#\n\r\s]`. The
//     final class forces the name-run to END in a non-whitespace char, so
//     ordinary prose like `@bob check issue #0042` is NOT swallowed into one
//     pill (the only `#` there is space-preceded). The tag is `#dddd` with 4+
//     digits (variable-width disc); the digit run is greedy so a widened 5+-digit
//     tag matches in full. A hand-typed bare `@Alice` (no tag) is intentionally
//     NOT a mention — it stays text.
const MENTION_RE =
  /@everyone(?![\p{L}\p{N}_-])|@[^@#\n\r]*[^@#\n\r\s]#\d{4,}/gu

/** mdast node produced by `@name`/`@name#0042`/`@everyone`. */
export interface MentionNode {
  type: "mention"
  /** Display name — `#dddd` discriminator, if present, is stripped from here (matches the old `<mention>` tag's content). */
  value: string
  everyone: boolean
  /** The discriminator (4+ decimal digits), if the mention carried one (never set for `@everyone`). */
  discriminator?: string
}

/** mdast node produced by a `/server/channel` or `/server/channel/#N` ref. */
export interface ChannelRefNode {
  type: "channelRef"
  value: string
}

/** mdast node produced by a bare `/server` ref (no channel segment). */
export interface ServerRefNode {
  type: "serverRef"
  value: string
}

declare module "mdast" {
  interface RootContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
    serverRef: ServerRefNode
  }
  interface PhrasingContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
    serverRef: ServerRefNode
  }
}

// `ignore` list mirrors mdast-util-find-and-replace's own default protection
// for GFM autolinks/definitions, plus `code`/`inlineCode` so `@fake-mention`,
// `#0042`, `/server/channel`, and `||spoiler||` all stay literal inside a
// code span or fenced code block — replacing the old `preprocessMarkdown`'s
// manual stash/unstash sentinel dance, which existed only because that
// implementation operated on a raw string before markdown parsing.
const IGNORE_NODE_TYPES = ["code", "inlineCode", "link", "linkReference"]

function mentionReplacer(value: string): MentionNode {
  const everyone = value === "@everyone"
  if (everyone) return { type: "mention", value, everyone: true }
  const tag = /#(\d{4,})$/.exec(value)
  const bare = value.replace(/#\d{4,}$/, "")
  return tag ? { type: "mention", value: bare, everyone: false, discriminator: tag[1] } : { type: "mention", value: bare, everyone: false }
}

function channelRefReplacer(value: string): ChannelRefNode {
  return { type: "channelRef", value }
}

function serverRefReplacer(value: string): ServerRefNode {
  return { type: "serverRef", value }
}

/**
 * remark plugin: combines the spoiler micromark extension (`spoiler-syntax.ts`)
 * with a `mdast-util-find-and-replace` pass for `mention`/`channelRef`.
 * Registers `spoilerSyntax`'s micromark/from-markdown extensions on the
 * processor (the `remark-gfm`-style `this.data(...)` convention) and returns
 * a tree transform running the find-and-replace pass after parsing.
 */
export const chatSyntaxPlugin: Plugin<[], Root> = function chatSyntaxPlugin(this: import("unified").Processor) {
  type ProcessorData = { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }
  const settings = this.data() as ProcessorData
  const micromarkExtensions = (settings.micromarkExtensions ??= [])
  const fromMarkdownExtensions = (settings.fromMarkdownExtensions ??= [])
  micromarkExtensions.push(spoilerSyntax())
  fromMarkdownExtensions.push(spoilerFromMarkdown())

  return function transform(tree: Root): void {
    findAndReplace(
      tree,
      [
        [MENTION_RE, mentionReplacer as unknown as (value: string, ...rest: unknown[]) => PhrasingContent | string | false],
        [CHANNEL_REF_RE, channelRefReplacer as unknown as (value: string) => PhrasingContent],
        // Runs as its own pass AFTER the channelRef pass above — by then every
        // `/server/channel` span is already a `channelRef` element (no longer
        // a `text` node `findAndReplace` visits), so this pass only ever sees
        // genuine bare `/server` refs among the remaining text.
        [SERVER_REF_RE, serverRefReplacer as unknown as (value: string) => PhrasingContent],
      ],
      { ignore: IGNORE_NODE_TYPES },
    )
  }
}

// `remarkRehypeOptions.handlers` — converts each custom mdast node directly
// into a hast element, skipping the HTML-string round-trip entirely. Tag
// names/attributes match the old string-spliced tags exactly
// (`<spoiler>`/`<mention data-everyone/data-tag>`/`<channelref>`) so
// `MD_ALLOWED_TAGS`/`MD_COMPONENTS` in `message-markdown.tsx` need no change.
export const chatSyntaxHandlers: Handlers = {
  spoiler: ((state, node: SpoilerNode): Element => ({
    type: "element",
    tagName: "spoiler",
    properties: {},
    children: state.all(node),
  })) as Handler,
  mention: ((_state, node: MentionNode): Element => ({
    type: "element",
    tagName: "mention",
    properties: {
      ...(node.everyone ? { dataEveryone: "1" } : {}),
      ...(node.discriminator ? { dataTag: node.discriminator } : {}),
    },
    children: [{ type: "text", value: node.value }],
  })) as Handler,
  channelRef: ((_state, node: ChannelRefNode): Element => ({
    type: "element",
    tagName: "channelref",
    properties: {},
    children: [{ type: "text", value: node.value }],
  })) as Handler,
  serverRef: ((_state, node: ServerRefNode): Element => ({
    type: "element",
    tagName: "serverref",
    properties: {},
    children: [{ type: "text", value: node.value }],
  })) as Handler,
}
