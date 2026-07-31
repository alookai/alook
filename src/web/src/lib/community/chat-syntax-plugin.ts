import type { Root, PhrasingContent } from "mdast"
import { findAndReplace } from "mdast-util-find-and-replace"
import type { Handler, Handlers } from "mdast-util-to-hast"
import type { Element } from "hast"
import type { Plugin } from "unified"
import { spoilerSyntax, spoilerFromMarkdown } from "./spoiler-syntax"
import type { SpoilerNode } from "./spoiler-syntax"
import { refTokenGlobalRe, type RefTokenType } from "./ref-token"

// Chat-only syntax (`||spoiler||`, `@mention`, and the authoritative
// `{label}(type/id)` ref token), parsed as real markdown AST nodes rather than
// string-spliced HTML tags fed through `rehype-raw`. A member `mention` is
// `@<name>#dddd` where the name may contain spaces but never a markdown
// metacharacter (validateCommunityName forbids `#`/`@`/line breaks, and the
// composer only ever inserts names picked from the roster), so a
// `mdast-util-find-and-replace` pass stays safe — `remark-parse` won't split
// these tokens across sibling text nodes. `spoiler` is handled separately by
// the micromark tokenizer extension in `spoiler-syntax.ts` — see that file's
// comment for why find-and-replace cannot handle spoilers containing nested
// formatting.

// NOTE: the legacy bare-ref detection (`CHANNEL_REF_RE`/`SERVER_REF_RE`, plus
// their `REF_TERM`/`REF_SEG` charset) was removed with ref/id decision B
// (Gener): the composer now emits an authoritative `{label}(type/id)` ref token
// for every channel/server/message ref, and that token is the ONLY thing this
// plugin turns into a pill. A bare `/server/channel` (or `/server`) in message
// text — a stale one from an old message, or a hand-typed one — is no longer
// recognized and stays plain text. Single path, no legacy branch. See
// `ref-token.ts` for the token grammar.

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
//     pill (the only `#` there is space-preceded). `(?!\d)` after `#dddd` stops
//     a 5+-digit run from matching a 4-digit tag (`@Gus#00423`). A hand-typed
//     bare `@Alice` (no tag) is intentionally NOT a mention — it stays text.
const MENTION_RE =
  /@everyone(?![\p{L}\p{N}_-])|@[^@#\n\r]*[^@#\n\r\s]#\d{4}(?!\d)/gu

/** mdast node produced by `@name`/`@name#0042`/`@everyone`. */
export interface MentionNode {
  type: "mention"
  /** Display name — `#dddd` discriminator, if present, is stripped from here (matches the old `<mention>` tag's content). */
  value: string
  everyone: boolean
  /** The 4-digit discriminator, if the mention carried one (never set for `@everyone`). */
  discriminator?: string
}

/**
 * mdast node produced by an authoritative `{label}(type/id)` ref token (ref/id
 * §3). `label` is the unescaped full-path human form (readable fallback); `id`
 * is the authoritative target and `refType` names its table.
 */
export interface RefTokenNode {
  type: "refToken"
  label: string
  refType: RefTokenType
  id: string
}

declare module "mdast" {
  interface RootContentMap {
    mention: MentionNode
    refToken: RefTokenNode
  }
  interface PhrasingContentMap {
    mention: MentionNode
    refToken: RefTokenNode
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
  const tag = /#(\d{4})$/.exec(value)
  const bare = value.replace(/#\d{4}$/, "")
  return tag ? { type: "mention", value: bare, everyone: false, discriminator: tag[1] } : { type: "mention", value: bare, everyone: false }
}

// `findAndReplace` passes the capture groups after the full match: group 1 =
// escaped label, group 2 = type, group 3 = id. The regex's type alternation
// already whitelists {channel,message,server} and the id charset, so any match
// here is well-formed; a malformed token simply never matches and stays text.
function refTokenReplacer(
  _full: string,
  label: string,
  refType: string,
  id: string,
): RefTokenNode {
  return { type: "refToken", label, refType: refType as RefTokenType, id }
}


/**
 * remark plugin: combines the spoiler micromark extension (`spoiler-syntax.ts`)
 * with a `mdast-util-find-and-replace` pass for `mention`/`refToken`.
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
        // The authoritative `{label}(type/id)` token is the ONLY thing that
        // renders as a channel/message/server pill (ref/id §3, decision B —
        // Gener: single path, no legacy branch). A bare `/server/channel` in
        // message text — whether a stale one in an old message or a hand-typed
        // one — is NOT recognized and stays plain text. (Both `channelRef` and
        // `serverRef` passes were intentionally removed here; the composer emits
        // the token now, so nothing produces those nodes anymore.)
        [refTokenGlobalRe(), refTokenReplacer as unknown as (value: string, ...rest: unknown[]) => PhrasingContent],
        [MENTION_RE, mentionReplacer as unknown as (value: string, ...rest: unknown[]) => PhrasingContent | string | false],
      ],
      { ignore: IGNORE_NODE_TYPES },
    )
  }
}

// `remarkRehypeOptions.handlers` — converts each custom mdast node directly
// into a hast element, skipping the HTML-string round-trip entirely. Tag
// names/attributes match the old string-spliced tags exactly
// (`<spoiler>`/`<mention data-everyone/data-tag>`/`<reftoken>`) so
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
  refToken: ((_state, node: RefTokenNode): Element => ({
    type: "element",
    tagName: "reftoken",
    // id/type are the authoritative target; the label is the readable fallback
    // rendered when the id can't be resolved to a live name.
    properties: { dataType: node.refType, dataId: node.id, dataLabel: node.label },
    children: [{ type: "text", value: node.label }],
  })) as Handler,
}
