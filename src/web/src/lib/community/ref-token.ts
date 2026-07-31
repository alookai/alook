// Body-reference token for the ref/id coexistence contract (§3). A reference to
// a channel/message/server embedded in message text serializes as
//
//   {full-path label}(type/leafid)
//
// e.g. `{/Alook/general}(channel/K9f_rnJk)`, `{/Alook/general#42}(message/m_ab)`,
// `{/Alook}(server/srv_x)`. The `{}` label is the human-readable, self-describing
// fallback (shown on degrade / plaintext / copy-out); the `(type/leafid)` is the
// authoritative target — `type` names which table (channel/message/server ids
// are same-shape nanoids, so type can't be inferred), `leafid` locates it.
//
// `{}` is chosen because markdown leaves it literal (unlike `[]()` which becomes
// a link, or `<>` which becomes HTML/autolink; Gener #65). No escape layer: the
// label is a DISPLAY-ONLY fallback (the id is authoritative), so rather than
// escape the closing `}` inside it — which collides with markdown's OWN `\`
// escaping once the token sits in message body text — the producer simply
// strips `}` from the label (`sanitizeLabel`). `}` is legal-but-rare in a name;
// a real `plan}b` channel still renders its true name via the id→live-name
// hybrid, and only the no-client plaintext fallback shows the sanitized form.
// (Markdown metacharacters like `*`/`_` in a name can still fragment the token
// the same way they already break the LEGACY bare `/server/channel` ref — a
// pre-existing limitation, out of scope here.)

export type RefTokenType = "channel" | "message" | "server"

export interface RefToken {
  label: string
  type: RefTokenType
  id: string
}

const REF_TOKEN_RE =
  /\{([^}]*)\}\((channel|message|server)\/([A-Za-z0-9_-]+)\)/

// Global variant for the message-body find-and-replace pass (per-match state
// must not leak between calls, so `RE` above stays non-global for single
// `parseRefToken` use; callers scanning a whole string use their own global
// clone).
export function refTokenGlobalRe(): RegExp {
  return new RegExp(REF_TOKEN_RE.source, "gu")
}

// Strip the closing delimiter from a label before embedding. `}` collapses to
// `_` (rather than deletion) so two segments don't silently fuse into a new
// word. Producer-side only; the label is a display fallback, not the target.
export function sanitizeLabel(label: string): string {
  return label.replace(/\}/g, "_")
}

// Serialize a reference to its wire token. `label` is the full-path human form
// (e.g. `/Alook/general#42`), sanitized so a `}` in a name can't break the
// closing delimiter.
export function formatRefToken(token: RefToken): string {
  return `{${sanitizeLabel(token.label)}}(${token.type}/${token.id})`
}

// Parse a single token string. Returns null when it doesn't match the grammar
// or carries a non-whitelisted type / malformed id — the caller degrades a
// non-match to plain text (never throws, never drops).
export function parseRefToken(raw: string): RefToken | null {
  const m = REF_TOKEN_RE.exec(raw)
  if (!m || m.index !== 0 || m[0].length !== raw.length) return null
  return { label: m[1]!, type: m[2] as RefTokenType, id: m[3]! }
}
