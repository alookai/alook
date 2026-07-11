import type { Root, PhrasingContent } from "mdast"
import { findAndReplace } from "mdast-util-find-and-replace"
import type { Handler, Handlers } from "mdast-util-to-hast"
import type { Element } from "hast"
import type { Plugin } from "unified"
import { spoilerSyntax, spoilerFromMarkdown } from "./spoiler-syntax"
import type { SpoilerNode } from "./spoiler-syntax"

// Chat-only syntax (`||spoiler||`, `@mention`, `/server/channel` refs),
// parsed as real markdown AST nodes rather than string-spliced HTML tags fed
// through `rehype-raw`. `mention`/`channelRef` content is always an
// identifier charset (`\p{L}\p{N}_-` for names, `[A-Za-z0-9_-]` for
// nanoid-based refs) — `remark-parse` never splits an identifier across
// sibling text nodes (no markdown metacharacters inside one), so a
// `mdast-util-find-and-replace` pass is safe for these two. `spoiler` is
// handled separately by the micromark tokenizer extension in
// `spoiler-syntax.ts` — see that file's comment for why find-and-replace
// cannot handle spoilers containing nested formatting.

// Mirrors `CHANNEL_REF_REGEX`'s old doc comment: matches a `/server/channel`
// or `/server/channel/#N` (thread) ref — the CLI's path grammar
// (`parseRef`/`formatRef` in `community-cli-contract.ts`). Segment charset
// `[A-Za-z0-9_-]+` is the nanoid alphabet every `communityServer.id`/
// `communityChannel.id` is generated with. Trailing
// `(?=\s|$|[.,;:!?)\]])` boundary lookahead: a 2-segment path followed by
// ANOTHER `/segment` (e.g. `/api/user/123` in a docs URL) must NOT match —
// otherwise this regex would greedily take `/api/user` and orphan `/123` as
// trailing text next to a broken pill. Leading `(?<=^|\s)` lookbehind
// (verified empirically — a bare leading `\/` with no lookbehind would let
// this match START mid-path, e.g. matching `/user/123` inside
// `/api/user/123`): `" /channel-ref"` matches, `"text/channel-ref"` doesn't.
// Both boundaries are zero-width lookaround (not capture groups) so
// `findAndReplace` doesn't need to redistribute a leading/trailing text
// node around the match the way the old string-splice regex's `(^|\s)`
// capture group did.
const CHANNEL_REF_RE = /(?<=^|\s)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/#\d+)?(?=\s|$|[.,;:!?)\]])/g

// `@name`, `@name#0042` (disambiguating discriminator), or the literal
// `@everyone`/`@here` tokens. `\p{L}\p{N}_-` (Unicode-aware, `u` flag) in
// place of the old `\w` — `Member.name` is a free Unicode string (no
// charset constraint), so an ASCII-only `\w` silently dropped mentions for
// names like `李四`/`José`/`Ünal`. The `(?!\d)` lookahead after the
// discriminator group stops a 5+-digit run from being truncated into a
// false-positive handle (e.g. `@Gus#00423` must not become `@Gus` + a
// dangling `#0042` handle).
const MENTION_RE = /@[\p{L}\p{N}_-]+(?:#\d{4}(?!\d))?/gu

/** mdast node produced by `@name`/`@name#0042`/`@everyone`/`@here`. */
export interface MentionNode {
  type: "mention"
  /** Display name — `#dddd` discriminator, if present, is stripped from here (matches the old `<mention>` tag's content). */
  value: string
  everyone: boolean
  /** The 4-digit discriminator, if the mention carried one (never set for `@everyone`/`@here`). */
  discriminator?: string
}

/** mdast node produced by a `/server/channel` or `/server/channel/#N` ref. */
export interface ChannelRefNode {
  type: "channelRef"
  value: string
}

declare module "mdast" {
  interface RootContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
  }
  interface PhrasingContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
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
  const everyone = value === "@everyone" || value === "@here"
  if (everyone) return { type: "mention", value, everyone: true }
  const tag = /#(\d{4})$/.exec(value)
  const bare = value.replace(/#\d{4}$/, "")
  return tag ? { type: "mention", value: bare, everyone: false, discriminator: tag[1] } : { type: "mention", value: bare, everyone: false }
}

function channelRefReplacer(value: string): ChannelRefNode {
  return { type: "channelRef", value }
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
}
