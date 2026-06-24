import { Streamdown } from "streamdown"
import {
  escapeHtml,
  preprocessMarkdown,
  MD_ALLOWED_TAGS,
  MD_LITERAL_TAGS,
  MD_COMPONENTS,
} from "./message-markdown"

// Message body renderer. Standard markdown (bold/italic/strike/code/codeblock/quote)
// is rendered natively by streamdown (GFM, matching agent-chat). Chat-only syntax
// (spoilers, @mentions, @everyone/@here, #channels) is preprocessed into custom tags
// and mapped to pill components — no custom markdown parser.
export function MessageBody({ text }: { text: string }) {
  return (
    <div className="markdown text-[15px] leading-[1.4]">
      <Streamdown
        parseIncompleteMarkdown={false}
        linkSafety={{ enabled: false }}
        controls={{ code: { copy: false, download: false } }}
        allowedTags={MD_ALLOWED_TAGS}
        literalTagContent={MD_LITERAL_TAGS}
        components={MD_COMPONENTS}
      >
        {preprocessMarkdown(escapeHtml(text))}
      </Streamdown>
    </div>
  )
}
