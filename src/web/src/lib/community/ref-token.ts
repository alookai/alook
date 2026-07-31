// Body-reference token for the ref/id coexistence contract (§3).
//
// The AUTHORITATIVE definition now lives in `@alook/shared`'s
// `community-cli-contract.ts`, colocated with `parseRef`/`formatRef` so the two
// ref grammars (addressing path + body token) sit in one place and the CLI —
// which reaches shared via the `@alook/shared/community-cli-contract` subpath —
// reuses the SAME parser instead of a second copy (ref/id 乙, Blondie #268).
// This module is a thin re-export so the message renderer and composer keep
// their existing `@/lib/community/ref-token` import path unchanged.
//
// See the shared file for the token grammar (`{full-path label}(type/leafid)`),
// the `{}`-delimiter rationale, and the no-escape-layer / `sanitizeLabel`
// decision.

export {
  refTokenGlobalRe,
  sanitizeLabel,
  formatRefToken,
  parseRefToken,
} from "@alook/shared/community-cli-contract"
// Only `RefTokenType` is consumed by the web renderer/composer; the `RefToken`
// interface is used by the shared producer/CLI, re-exported from shared directly
// where needed. (Re-exporting it here would be an unused web symbol — knip.)
export type { RefTokenType } from "@alook/shared/community-cli-contract"
