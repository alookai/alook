import { useMemo } from "react"
import { Streamdown } from "streamdown"
import { mermaid, cjk, math } from "@/lib/streamdown-plugins"
import {
  escapeHtml,
  preprocessMarkdown,
  extractInviteTokens,
  MD_ALLOWED_TAGS,
  MD_LITERAL_TAGS,
  buildMdComponents,
} from "./message-markdown"
import { CommunityInviteCard } from "./community-invite-card"
import type { OpenProfile } from "./_types"

// Message body renderer. Standard markdown (bold/italic/strike/code/codeblock/quote)
// is rendered natively by streamdown (GFM, matching agent-chat). The shared
// mermaid/math/cjk plugins give parity with the agent bubble (diagrams, KaTeX
// math, CJK spacing) and operate on different constructs than the chat-only
// syntax (spoilers, @mentions, @everyone/@here, #channels) that's preprocessed
// into custom tags and mapped to pill components — no custom markdown parser.
//
// Community invite URLs (`/community/invite/<token>`) render inline: the
// URL stays as a plain auto-linked <a> in the message body, and a rich join
// card renders BELOW it. Both surfaces coexist so users can still copy/share
// the raw link even when the card is present.
export function MessageBody({ text, onOpenProfile }: { text: string; onOpenProfile?: OpenProfile }) {
  const inviteTokens = extractInviteTokens(text)
  const components = useMemo(() => buildMdComponents(onOpenProfile), [onOpenProfile])
  return (
    <div className="markdown text-[15px] leading-snug">
      <Streamdown
        parseIncompleteMarkdown={false}
        plugins={{ mermaid, cjk, math }}
        linkSafety={{ enabled: false }}
        controls={{
          code: { copy: true, download: false },
          table: { copy: true, download: false, fullscreen: true },
        }}
        allowedTags={MD_ALLOWED_TAGS}
        literalTagContent={MD_LITERAL_TAGS}
        components={components}
      >
        {preprocessMarkdown(escapeHtml(text))}
      </Streamdown>
      {inviteTokens.length > 0 && (
        // `pb-2` is *inside* the message row so the row's hover tint
        // (`bg-accent/40`) extends below the card. A margin on the card
        // itself wouldn't do that — it'd push the card out of the row's
        // padding area.
        <div className="flex flex-col gap-2 pb-2">
          {inviteTokens.map((token) => (
            <CommunityInviteCard key={token} token={token} />
          ))}
        </div>
      )}
    </div>
  )
}
