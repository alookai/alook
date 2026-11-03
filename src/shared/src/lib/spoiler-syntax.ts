import { splice } from "micromark-util-chunked"
import { classifyCharacter } from "micromark-util-classify-character"
import { resolveAll } from "micromark-util-resolve-all"
import { codes } from "micromark-util-symbol"
import type { Construct, Effects, Event, Extension, State, Token, TokenizeContext } from "micromark-util-types"
import type { CompileContext, Extension as FromMarkdownExtension, Handle as FromMarkdownHandle } from "mdast-util-from-markdown"

// Discord-style `||spoiler||` — a micromark inline tokenizer extension +
// mdast-util-from-markdown extension, structurally mirroring
// micromark-extension-gfm-strikethrough/mdast-util-gfm-strikethrough (`~~text~~`)
// with `|` (code 124) in place of `~` (code 126). Recognizing the `||`
// boundary during TOKENIZATION (the same phase that recognizes `**`/`*`/`` ` ``)
// — rather than as a text-node find-and-replace pass after parsing — is what
// lets `||I think **this** is neat||` correctly produce a `spoiler` node
// containing a nested `strong` node. A text-node find-and-replace can't do
// this: remark-parse would already have split that input into 3 sibling
// nodes (text, strong, text) before any post-processing plugin runs, so the
// two `|` markers never co-occur in one text node to match against.

declare module "micromark-util-types" {
  interface TokenTypeMap {
    spoilerSequence: "spoilerSequence"
    spoilerSequenceTemporary: "spoilerSequenceTemporary"
    spoiler: "spoiler"
    spoilerText: "spoilerText"
  }
}

declare module "mdast" {
  interface RootContentMap {
    spoiler: SpoilerNode
  }
  interface PhrasingContentMap {
    spoiler: SpoilerNode
  }
}

/** mdast node produced by `||...||` — a phrasing-content parent, like `emphasis`/`strong`. */
export interface SpoilerNode {
  type: "spoiler"
  children: import("mdast").PhrasingContent[]
}

/** Micromark extension enabling `||...||` spoiler syntax during tokenization. */
export function spoilerSyntax(): Extension {
  const tokenizer: Construct = {
    name: "spoiler",
    tokenize: tokenizeSpoiler,
    resolveAll: resolveAllSpoiler,
  }
  return {
    text: { [codes.verticalBar]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [codes.verticalBar] },
  }

  function resolveAllSpoiler(events: Event[], context: TokenizeContext): Event[] {
    let index = -1
    while (++index < events.length) {
      if (
        events[index][0] === "enter" &&
        events[index][1].type === "spoilerSequenceTemporary" &&
        events[index][1]._close
      ) {
        let open = index
        while (open--) {
          if (
            events[open][0] === "exit" &&
            events[open][1].type === "spoilerSequenceTemporary" &&
            events[open][1]._open &&
            events[index][1].end.offset - events[index][1].start.offset ===
              events[open][1].end.offset - events[open][1].start.offset
          ) {
            events[index][1].type = "spoilerSequence"
            events[open][1].type = "spoilerSequence"

            const spoiler: Token = {
              type: "spoiler",
              start: Object.assign({}, events[open][1].start),
              end: Object.assign({}, events[index][1].end),
            }
            const text: Token = {
              type: "spoilerText",
              start: Object.assign({}, events[open][1].end),
              end: Object.assign({}, events[index][1].start),
            }

            const nextEvents: Event[] = [
              ["enter", spoiler, context],
              ["enter", events[open][1], context],
              ["exit", events[open][1], context],
              ["enter", text, context],
            ]
            const insideSpan = context.parser.constructs.insideSpan.null
            if (insideSpan) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context))
            }
            splice(nextEvents, nextEvents.length, 0, [
              ["exit", text, context],
              ["enter", events[index][1], context],
              ["exit", events[index][1], context],
              ["exit", spoiler, context],
            ])
            splice(events, open - 1, index - open + 3, nextEvents)
            index = open + nextEvents.length - 2
            break
          }
        }
      }
    }
    index = -1
    while (++index < events.length) {
      if (events[index][1].type === "spoilerSequenceTemporary") {
        events[index][1].type = "data"
      }
    }
    return events
  }

  function tokenizeSpoiler(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = this.previous
    const events = this.events
    let size = 0
    return start

    function start(code: Parameters<State>[0]): State | undefined {
      if (previous === codes.verticalBar && events[events.length - 1][1].type !== "characterEscape") {
        return nok(code)
      }
      effects.enter("spoilerSequenceTemporary")
      return more(code)
    }

    function more(code: Parameters<State>[0]): State | undefined {
      const before = classifyCharacter(previous)
      if (code === codes.verticalBar) {
        if (size > 1) return nok(code)
        effects.consume(code)
        size++
        return more
      }
      // Only the doubled `||` marker forms a spoiler boundary — a lone `|`
      // (e.g. inside a table row, which this codebase's Streamdown/GFM
      // pipeline also parses) must fall through untouched.
      if (size < 2) return nok(code)
      const token = effects.exit("spoilerSequenceTemporary")
      const after = classifyCharacter(code)
      token._open = !after || (after === 2 && Boolean(before))
      token._close = !before || (before === 2 && Boolean(after))
      return ok(code)
    }
  }
}

/** mdast-util-from-markdown extension: turns the `spoiler` token into a `spoiler` mdast node. */
export function spoilerFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ["spoiler"],
    enter: { spoiler: enterSpoiler },
    exit: { spoiler: exitSpoiler },
  }
}

const enterSpoiler: FromMarkdownHandle = function (this: CompileContext, token) {
  this.enter({ type: "spoiler", children: [] }, token)
}

const exitSpoiler: FromMarkdownHandle = function (this: CompileContext, token) {
  this.exit(token)
}
