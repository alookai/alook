import type { Root, PhrasingContent, Text } from "mdast"
import { findAndReplace } from "mdast-util-find-and-replace"
import type { CompileContext, Extension as FromMarkdownExtension, Handle as FromMarkdownHandle } from "mdast-util-from-markdown"
import { codes } from "micromark-util-symbol"
import type { Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types"
import type { Plugin } from "unified"
import { MENTION_IDENTIFIER_CHARACTERS, isMentionStartBoundary, isMentionEndBoundary } from "../utils/community-mentions"
import { spoilerSyntax, spoilerFromMarkdown } from "./spoiler-syntax"

// Refs use canonical full paths; #N is a channel message and /#N#M is a thread message.
// Tagged mentions require a discriminator of at least four digits. Only @everyone broadcasts.
// @here and bare #N stay literal. Preserve sentence punctuation and do not match partial URLs.
// Code and inlineCode stay literal.
const REF_TERM = ".,;:!?)\\]}\"'\\u2014\\u2019\\u201D\\u2026\\u3001\\u3002\\u3009\\u300B\\u300D\\u300F\\u3011\\u3015\\u3017\\u3019\\u301B\\uFF01\\uFF02\\uFF07\\uFF09\\uFF0C\\uFF0E\\uFF1A\\uFF1B\\uFF1F\\uFF3D\\uFF5D"
const REF_SEG = `[^\\s/#${REF_TERM}]+`
const HANDLE_SEG = `${REF_SEG}#\\d{4,}`

const CHANNEL_REF_RE = new RegExp(`(?<!/[^\\s${REF_TERM}]*)(?:/${HANDLE_SEG}/${REF_SEG}|/\\.dm/${HANDLE_SEG})(?:#\\d+|/#\\d+(?:#\\d+)?)?(?=\\s|$|[${REF_TERM}])`, "gu")

const SERVER_REF_RE = new RegExp(`(?<=^|\\s)/${HANDLE_SEG}(?=\\s|$|[${REF_TERM}])`, "gu")

const MENTION_RE = new RegExp(
  String.raw`(?<!/|${MENTION_IDENTIFIER_CHARACTERS})(?:@everyone(?!${MENTION_IDENTIFIER_CHARACTERS})|@[^@#\n\r]*[^@#\n\r\s]#\d{4,}(?!${MENTION_IDENTIFIER_CHARACTERS}))`,
  "gu",
)

/** mdast node produced by `@name`/`@name#0042`/`@everyone`. */
export interface MentionNode {
  type: "mention"
  /** Display name — `#dddd` discriminator, if present, is stripped from here (matches the old `<mention>` tag's content). */
  value: string
  everyone: boolean
  /** The discriminator (4+ decimal digits), if the mention carried one (never set for `@everyone`). */
  discriminator?: string
}

/** mdast node produced by a `/server#disc/channel` or `/server#disc/channel/#N` ref. */
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
    chatLiteral: ChatLiteralNode
    mention: MentionNode
    channelRef: ChannelRefNode
    serverRef: ServerRefNode
  }
  interface PhrasingContentMap {
    chatLiteral: ChatLiteralNode
    mention: MentionNode
    channelRef: ChannelRefNode
    serverRef: ServerRefNode
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    memberMention: "memberMention"
    memberMentionBoundary: "memberMentionBoundary"
  }
}

function memberMentionSyntax(): Extension {
  const construct: Construct = {
    name: "memberMention",
    previous(code) {
      if (code === codes.slash) return false
      if (code === null || code < 0) return true
      let previous = String.fromCodePoint(code)
      if (code >= 0xDC00 && code <= 0xDFFF) {
        const tail = this.events.at(-1)?.[1]
        if (tail) previous = this.sliceSerialize({ start: tail.start, end: this.now() })
      }
      return isMentionStartBoundary(previous)
    },
    tokenize: tokenizeMemberMention,
  }
  return { text: { [codes.atSign]: construct } }
}

function tokenizeMemberMention(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let nameSize = 0
  let previousWasWhitespace = false
  let discriminatorSize = 0

  return start

  function start(code: Parameters<State>[0]): State | undefined {
    effects.enter("memberMention")
    effects.consume(code)
    return name
  }

  function name(code: Parameters<State>[0]): State | undefined {
    if (
      code === codes.eof ||
      code === codes.atSign ||
      code === codes.carriageReturn ||
      code === codes.lineFeed ||
      code === codes.carriageReturnLineFeed
    ) {
      return nok(code)
    }
    if (code === codes.numberSign) {
      if (nameSize === 0 || previousWasWhitespace) return nok(code)
      effects.consume(code)
      return discriminator
    }
    effects.consume(code)
    nameSize++
    previousWasWhitespace = code === codes.space || code === codes.horizontalTab || code === codes.virtualSpace
    return name
  }

  function discriminator(code: Parameters<State>[0]): State | undefined {
    if (code !== null && code >= codes.digit0 && code <= codes.digit9) {
      effects.consume(code)
      discriminatorSize++
      return discriminator
    }
    if (discriminatorSize < 4) return nok(code)
    return effects.check(memberMentionEndBoundary, finish, nok)(code)
  }

  function finish(code: Parameters<State>[0]): State | undefined {
    effects.exit("memberMention")
    return ok(code)
  }
}

const memberMentionEndBoundary: Construct = {
  tokenize(effects, ok, nok) {
    let high = ""
    return start

    function start(code: Parameters<State>[0]): State | undefined {
      if (code === null || code < 0) return ok(code)
      if (code >= 0xD800 && code <= 0xDBFF) {
        high = String.fromCharCode(code)
        effects.enter("memberMentionBoundary")
        effects.consume(code)
        return afterHigh
      }
      return isMentionEndBoundary(String.fromCodePoint(code)) ? ok(code) : nok(code)
    }

    function afterHigh(code: Parameters<State>[0]): State | undefined {
      effects.exit("memberMentionBoundary")
      const suffix = code !== null && code >= 0xDC00 && code <= 0xDFFF
        ? high + String.fromCharCode(code)
        : high
      return isMentionEndBoundary(suffix) ? ok(code) : nok(code)
    }
  },
}

interface ChatLiteralNode extends Omit<Text, "type"> {
  type: "chatLiteral"
}

function literalFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      characterEscape: enterLiteral,
      characterReference: enterLiteral,
    },
    exit: {
      characterEscapeValue: appendEscapeValue,
      characterEscape: exitLiteral,
      characterReference: exitLiteral,
    },
  }
}

const enterLiteral: FromMarkdownHandle = function (token) {
  this.enter({ type: "chatLiteral", value: "" }, token)
}

const appendEscapeValue: FromMarkdownHandle = function (token) {
  const node = this.stack.at(-1) as ChatLiteralNode
  node.value += this.sliceSerialize(token)
}

const exitLiteral: FromMarkdownHandle = function (token) {
  this.exit(token)
}

function restoreLiteralNodes(node: TraversableSyntaxNode): void {
  if (!node.children) return
  for (const child of node.children) {
    if (child.type === "chatLiteral") child.type = "text"
    restoreLiteralNodes(child)
  }
}

function memberMentionFromMarkdown(): FromMarkdownExtension {
  return {
    enter: { memberMention: enterMemberMention },
    exit: { memberMention: exitMemberMention },
  }
}

const enterMemberMention: FromMarkdownHandle = function (this: CompileContext, token) {
  const serialized = this.sliceSerialize(token)
  const tagStart = serialized.lastIndexOf("#")
  this.enter({
    type: "mention",
    value: serialized.slice(0, tagStart),
    everyone: false,
    discriminator: serialized.slice(tagStart + 1),
  }, token)
}

const exitMemberMention: FromMarkdownHandle = function (this: CompileContext, token) {
  this.exit(token)
}

type TraversableSyntaxNode = {
  type: string
  children?: TraversableSyntaxNode[]
  value?: string
  discriminator?: string
  everyone?: boolean
}

function restoreProtectedMemberMentions(
  node: TraversableSyntaxNode,
  protectedAncestor = false,
): void {
  if (!node.children) return
  const childrenAreProtected = protectedAncestor || IGNORE_NODE_TYPES.includes(node.type)
  node.children = node.children.map((child) => {
    if (
      childrenAreProtected
      && child.type === "mention"
      && !child.everyone
      && child.value
      && child.discriminator
    ) {
      return {
        type: "text",
        value: `${child.value}#${child.discriminator}`,
      }
    }
    restoreProtectedMemberMentions(child, childrenAreProtected)
    return child
  })
}

// `ignore` list mirrors mdast-util-find-and-replace's own default protection
// for GFM autolinks/definitions, plus `code`/`inlineCode` so `@fake-mention`,
// `#0042`, `/server#disc/channel`, and `||spoiler||` all stay literal inside a
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

export const chatSyntaxPlugin: Plugin<[], Root> = function chatSyntaxPlugin(this: import("unified").Processor) {
  type ProcessorData = { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }
  const settings = this.data() as ProcessorData
  const micromarkExtensions = (settings.micromarkExtensions ??= [])
  const fromMarkdownExtensions = (settings.fromMarkdownExtensions ??= [])
  micromarkExtensions.push(memberMentionSyntax())
  fromMarkdownExtensions.push(memberMentionFromMarkdown(), literalFromMarkdown())
  micromarkExtensions.push(spoilerSyntax())
  fromMarkdownExtensions.push(spoilerFromMarkdown())

  return function transform(tree: Root): void {
    restoreProtectedMemberMentions(tree as TraversableSyntaxNode)
    findAndReplace(
      tree,
      [
        [MENTION_RE, mentionReplacer as unknown as (value: string, ...rest: unknown[]) => PhrasingContent | string | false],
        [CHANNEL_REF_RE, channelRefReplacer as unknown as (value: string) => PhrasingContent],

        [SERVER_REF_RE, serverRefReplacer as unknown as (value: string) => PhrasingContent],
      ],
      { ignore: IGNORE_NODE_TYPES },
    )
    restoreLiteralNodes(tree)
  }
}
