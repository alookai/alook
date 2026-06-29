import { Streamdown } from "streamdown"
import { mermaid, cjk, math } from "@/lib/streamdown-plugins"
import {
  escapeHtml,
  preprocessMarkdown,
  MD_ALLOWED_TAGS,
  MD_LITERAL_TAGS,
  MD_COMPONENTS,
} from "./message-markdown"

// Message body renderer. Standard markdown (bold/italic/strike/code/codeblock/quote)
// is rendered natively by streamdown (GFM, matching agent-chat). The shared
// mermaid/math/cjk plugins give parity with the agent bubble (diagrams, KaTeX
// math, CJK spacing) and operate on different constructs than the chat-only
// syntax (spoilers, @mentions, @everyone/@here, #channels) that's preprocessed
// into custom tags and mapped to pill components — no custom markdown parser.
export function MessageBody({ text }: { text: string }) {
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
        components={MD_COMPONENTS}
      >
        {preprocessMarkdown(escapeHtml(text))}
      </Streamdown>
    </div>
  )
}
