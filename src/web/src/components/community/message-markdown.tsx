import type React from "react"
import { Spoiler, MentionPill, ChannelPill } from "./inline-marks"

// Sentinels for stashing code spans/fences (private-use chars — won't collide with
// real text or markdown punctuation).
const S0 = "\u{E000}"
const S1 = "\u{E001}"

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
  out = out
    // CommonMark needs a blank line before a blockquote; chat-style quotes are line-by-line.
    // Insert one so a `> ` that immediately follows text still renders as a quote.
    .replace(/([^\n])\n(> )/g, "$1\n\n$2")
    .replace(/\|\|([\s\S]+?)\|\|/g, (_m, c) => `<spoiler>${c}</spoiler>`)
    // single mention pass so @everyone/@here aren't re-matched inside the tag just inserted
    .replace(/@[\w-]+/g, (m) =>
      m === "@everyone" || m === "@here"
        ? `<mention data-everyone="1">${m}</mention>`
        : `<mention>${m}</mention>`,
    )
    .replace(/(^|\s)#([\w-]+)/g, (_m, pre, name) => `${pre}<channel>#${name}</channel>`)
  return out.replace(new RegExp(`${S0}(\\d+)${S1}`, "g"), (_m, i) => stash[Number(i)])
}

export const MD_ALLOWED_TAGS = { spoiler: [], mention: ["data-everyone"], channel: [] }
export const MD_LITERAL_TAGS = ["spoiler", "mention", "channel"]

export const MD_COMPONENTS = {
  spoiler: ({ children }: { children?: React.ReactNode }) => <Spoiler>{children}</Spoiler>,
  mention: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <MentionPill everyone={rest["data-everyone"] === "1"}>{children}</MentionPill>
  ),
  channel: ({ children }: { children?: React.ReactNode }) => <ChannelPill>{children}</ChannelPill>,
} as Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>>
