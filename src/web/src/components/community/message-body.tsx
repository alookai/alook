import { useMemo } from "react"
import { Streamdown } from "streamdown"
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize"
import { harden } from "rehype-harden"
import type { PluggableList } from "unified"
import { mermaid, cjk, math } from "@/lib/streamdown-plugins"
import { chatSyntaxPlugin, chatSyntaxHandlers } from "@/lib/community/chat-syntax-plugin"
import {
  extractInviteTokens,
  MD_ALLOWED_TAGS,
  MD_LITERAL_TAGS,
  buildMdComponents,
} from "./message-markdown"
import { CommunityInviteCard } from "./community-invite-card"
import type { OpenProfile } from "./_types"

// The sanitize schema Streamdown builds internally when `allowedTags` is
// left at its default merge path (verified against Streamdown 2.5.0's
// compiled source): `defaultSchema` + `protocols.href` gains `"tel"` +
// `attributes.code` gains `"metastring"` (for the shiki code-highlighting
// metastring), THEN `MD_ALLOWED_TAGS`'s tag names/attributes are merged in.
// Reproduced here because dropping `rehype-raw` (below) requires supplying a
// custom `rehypePlugins` array, and Streamdown's `allowedTags`-merge-into-
// sanitize-schema auto-fire is gated by strict reference equality against
// Streamdown's own default `rehypePlugins` array — a gate any custom array
// breaks on purpose, so `allowedTags`/`MD_ALLOWED_TAGS` are NOT passed as a
// `<Streamdown>` prop below; this schema stands in for that merge instead.
const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel"],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), ...Object.keys(MD_ALLOWED_TAGS)],
}
for (const [tag, attrs] of Object.entries(MD_ALLOWED_TAGS)) {
  SANITIZE_SCHEMA.attributes = { ...SANITIZE_SCHEMA.attributes, [tag]: attrs }
}

// The exact `rehype-harden` config Streamdown ships as its own default —
// verified against the compiled source. This is the layer that
// unconditionally blocks `javascript:`/`data:`/`vbscript:`/`file:` links
// regardless of any other configuration (see debt record #9's finding —
// `linkSafety={{ enabled: false }}` below does NOT gate this; it only
// toggles the AI-content confirm-before-navigating modal).
const HARDEN_CONFIG = {
  allowedImagePrefixes: ["*"],
  allowedLinkPrefixes: ["*"],
  allowedProtocols: ["*"],
  defaultOrigin: undefined,
  allowDataImages: true,
}

// Hand-rolled replacement for Streamdown's default `rehypePlugins` pipeline
// (`[rehype-raw, [rehype-sanitize, schema], [rehype-harden, config]]`,
// verified against the compiled source) with `rehype-raw` dropped — chat-
// only syntax (spoiler/mention/channelRef) is now parsed as real mdast
// nodes by `chatSyntaxPlugin` (see the `remarkPlugins`/`remarkRehypeOptions`
// props below), never spliced into the message string as HTML tags, so
// there is nothing left for `rehype-raw` to parse. With `rehype-raw` gone,
// Streamdown's own remark-side fallback (any literal `html`-type mdast node
// — i.e. raw HTML the user typed, like `<b>bold</b>` — becomes a plain-text
// node) makes user-typed HTML render as literal text automatically.
const REHYPE_PLUGINS: PluggableList = [
  [rehypeSanitize, SANITIZE_SCHEMA],
  [harden, HARDEN_CONFIG],
]

// Message body renderer. Standard markdown (bold/italic/strike/code/codeblock/quote)
// is rendered natively by streamdown (GFM, matching agent-chat). The shared
// mermaid/math/cjk plugins give parity with the agent bubble (diagrams, KaTeX
// math, CJK spacing) and operate on different constructs than the chat-only
// syntax (spoilers, @mentions, @everyone/@here, #channels) that `chatSyntaxPlugin`
// parses directly into mdast nodes and maps to pill components — no custom
// markdown parser, no HTML-string splicing.
//
// Community invite URLs (`/c/invite/<token>`) render inline: the
// URL stays as a plain auto-linked <a> in the message body, and a rich join
// card renders BELOW it. Both surfaces coexist so users can still copy/share
// the raw link even when the card is present.
export function MessageBody({ text, onOpenProfile }: { text: string; onOpenProfile?: OpenProfile }) {
  const inviteTokens = useMemo(() => extractInviteTokens(text), [text])
  const components = useMemo(() => buildMdComponents(onOpenProfile), [onOpenProfile])
  return (
    <div className="markdown text-[15px] leading-snug">
      <Streamdown
        parseIncompleteMarkdown={false}
        plugins={{ mermaid, cjk, math }}
        remarkPlugins={[chatSyntaxPlugin]}
        remarkRehypeOptions={{ handlers: chatSyntaxHandlers }}
        rehypePlugins={REHYPE_PLUGINS}
        // Deliberately skips the AI-content confirm-before-navigating modal
        // — that feature exists for LLM-generated content where a model
        // could be prompt-injected into emitting a malicious-looking link;
        // community chat links are typed by the human sender, so a plain
        // hyperlink click is the expected behavior. Protocol/XSS filtering
        // is unconditional via `rehype-harden` above, unaffected by this
        // flag either way.
        linkSafety={{ enabled: false }}
        controls={{
          code: { copy: true, download: false },
          table: { copy: true, download: false, fullscreen: true },
        }}
        literalTagContent={MD_LITERAL_TAGS}
        components={components}
      >
        {text}
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
