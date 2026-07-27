import type { Root, PhrasingContent } from "mdast"
import { findAndReplace } from "mdast-util-find-and-replace"
import type { Handler, Handlers } from "mdast-util-to-hast"
import type { Element } from "hast"
import type { Plugin } from "unified"
import { spoilerSyntax, spoilerFromMarkdown } from "./spoiler-syntax"
import type { SpoilerNode } from "./spoiler-syntax"

// Chat-only syntax (`||spoiler||`, `@mention`, `<#serverId:channelId>`
// channel refs, `#N` message refs), parsed as real markdown AST nodes rather
// than string-spliced HTML tags fed through `rehype-raw`. A `channelRef`
// token carries two nanoid-charset ids (`[A-Za-z0-9_-]`); a member `mention`
// is `@<name>#dddd` where the name may contain spaces but never a markdown
// metacharacter (validateCommunityName forbids `#`/`@`/line breaks, and the
// composer only ever inserts names picked from the roster), so a
// `mdast-util-find-and-replace` pass stays safe — `remark-parse` won't split
// these tokens across sibling text nodes. `spoiler` is handled separately by
// the micromark tokenizer extension in `spoiler-syntax.ts` — see that file's
// comment for why find-and-replace cannot handle spoilers containing nested
// formatting.

// Channel-ref token `<#serverId:channelId>` — both segments are the nanoid
// alphabet (`[A-Za-z0-9_-]+`) every `communityServer.id`/`communityChannel.id`
// is generated with. The `<#…>` delimiters are unambiguous, so no boundary
// lookaround is needed. Code spans are excluded via `IGNORE_NODE_TYPES`.
const CHANNEL_REF_RE = /<#[A-Za-z0-9_-]+:[A-Za-z0-9_-]+>/g

// Message ref: `#NUMBER` where NUMBER is 1-6 digits (seq range 1-999999).
// Same boundary pattern as channel/server refs: leading `(?<=^|\s)` so
// `text#123` doesn't match (avoids GitHub issue refs, URL fragments),
// trailing `(?=\s|$|[.,;:!?)\]])` so it works inline and at EOL.
// Channel-scoped: `#123` refers to message seq 123 in the current channel,
// not a global identifier. Registered AFTER mention regex so `@Alice#0042`
// is parsed as mention first (4-digit discriminator), not broken into text
// `@Alice` + message ref `#0042`.
const MESSAGE_REF_RE = /(?<=^|\s)#\d{1,6}(?=\s|$|[.,;:!?)\]])/g

// Two-branch mention grammar (see plans/mandatory-mention-discriminator.md):
//
//  1. The literal `@everyone`/`@here` tokens, with a trailing
//     `(?![\p{L}\p{N}_-])` boundary guard so `@everyoneee` is NOT matched as
//     `@everyone` — this MUST agree with `detectMentionType`'s boundary check
//     (mention-extension.ts) and `community-mentions.ts`'s `ID_CHAR_RE`.
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
  /@(?:everyone|here)(?![\p{L}\p{N}_-])|@[^@#\n\r]*[^@#\n\r\s]#\d{4}(?!\d)/gu

/** mdast node produced by `@name`/`@name#0042`/`@everyone`/`@here`. */
export interface MentionNode {
  type: "mention"
  /** Display name — `#dddd` discriminator, if present, is stripped from here (matches the old `<mention>` tag's content). */
  value: string
  everyone: boolean
  /** The 4-digit discriminator, if the mention carried one (never set for `@everyone`/`@here`). */
  discriminator?: string
}

/** mdast node produced by a `<#serverId:channelId>` channel-ref token. */
export interface ChannelRefNode {
  type: "channelRef"
  /** The full matched token including delimiters (e.g. `"<#srv_1:chn_1>"`). */
  value: string
}

/** mdast node produced by `#NUMBER` (message seq ref in current channel). */
export interface MessageRefNode {
  type: "messageRef"
  /** The full matched string including `#` (e.g., `"#123"`). */
  value: string
}

declare module "mdast" {
  interface RootContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
    messageRef: MessageRefNode
  }
  interface PhrasingContentMap {
    mention: MentionNode
    channelRef: ChannelRefNode
    messageRef: MessageRefNode
  }
}

// `ignore` list mirrors mdast-util-find-and-replace's own default protection
// for GFM autolinks/definitions, plus `code`/`inlineCode` so `@fake-mention`,
// `#0042`, `<#srv:chn>`, and `||spoiler||` all stay literal inside a
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

function messageRefReplacer(value: string): MessageRefNode {
  return { type: "messageRef", value }
}

/**
 * remark plugin: combines the spoiler micromark extension (`spoiler-syntax.ts`)
 * with a `mdast-util-find-and-replace` pass for `mention`/`channelRef`/`messageRef`.
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
        [MESSAGE_REF_RE, messageRefReplacer as unknown as (value: string) => PhrasingContent],
        [CHANNEL_REF_RE, channelRefReplacer as unknown as (value: string) => PhrasingContent],
      ],
      { ignore: IGNORE_NODE_TYPES },
    )
  }
}

// `remarkRehypeOptions.handlers` — converts each custom mdast node directly
// into a hast element, skipping the HTML-string round-trip entirely. Tag
// names/attributes match the tags `MD_ALLOWED_TAGS`/`MD_COMPONENTS` in
// `message-markdown.tsx` allowlist
// (`<spoiler>`/`<mention data-everyone/data-tag>`/`<channelref>`/`<messageref>`).
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
  messageRef: ((_state, node: MessageRefNode): Element => ({
    type: "element",
    tagName: "messageref",
    properties: {},
    children: [{ type: "text", value: node.value }],
  })) as Handler,
}
