# Keys

New configurations contain one credential filter, `builtin.secrets`, named **Keys**. It runs the previous private-key, API-key, token and password/secret checks in their original order. It keeps `[REDACTED_PRIVATE_KEY]`, `[REDACTED_API_KEY]`, `[REDACTED_TOKEN]`, `[REDACTED_PASSWORD]` and `[REDACTED_SECRET]` distinct.

This is offline format recognition, not a check that a key was issued or remains valid. Publishable/public keys are included because the owner requested that coverage; matching one does not mean it is a secret.

| Format family | Recognized forms |
| --- | --- |
| Private key blocks | PEM private-key headers, including RSA/encrypted/OpenSSH and PGP private-key blocks |
| Stripe, Clerk, Paystack | `pk_`, `sk_`, `rk_` with `live_` or `test_`, followed by at least 20 payload characters; base64/URL-safe payload characters and trailing padding are accepted |
| Supabase | `sb_publishable_`, `sb_secret_` with at least 20 payload characters; legacy JWTs use the token check |
| Webhook signing secrets | `whsec_` with at least 20 payload characters |
| Existing provider-specific formats | OpenAI/Anthropic/OpenRouter-style `sk-` keys, provider `_sk_` forms, GitHub/GitLab, Google, Slack, AWS access-key IDs, Hugging Face, Groq, xAI, npm, PyPI, DigitalOcean and SendGrid; their prior length/boundary checks are retained |
| Alook credentials | `cmk_`, `cmt_`, `crk_`, `vch_` formats |
| Tokens | Recognizable JWT structure and Authorization/Bearer/Basic values |
| Passwords/secrets | Connection URL password components and credential-like assignments with the existing length/letter/digit guards; identifier/reference/env-variable exclusions remain |

An incomplete prefix, arbitrary opaque secret, a split/encoded key or an unsupported provider format can be missed. ASCII word/underscore boundaries prevent matching a key-looking fragment embedded in an ordinary reference. A match is replaced in full; surrounding labels and punctuation remain.

Primary format references: [Stripe](https://docs.stripe.com/keys), [Clerk](https://clerk.com/docs/guides/development/clerk-environment-variables), [Paystack](https://paystack.com/docs/developer-tools/api-keys/), [Supabase](https://supabase.com/docs/guides/getting-started/api-keys). The shared prefix family does not distinguish those providers from each other.

Saved configurations keep their installed sources, individual flags, deletions and custom rules. An upgrade does not automatically combine old nodes. A controlled synthetic preview conversion is separate from product migration.

## Plugin results and send receipts

A synchronous plugin returns `{ text: string, triggered: boolean }`. Set the bool from the plugin's accepted match path. The runner retains each node's bool, even if its output is unchanged or a later plugin restores earlier text. It does not infer new-protocol hits from the final pipeline difference. Invalid result fields, nonboolean flags, promises and exceptions block sending with safe errors; partial text and trigger records are not returned.

String-returning plugins remain accepted for compatibility. For each such node, the runner compares that node's input and output to estimate its bool. This cannot represent a legacy trigger that leaves text unchanged. Existing sources are executed, not skipped or rewritten. Use the object protocol for explicit trigger semantics.

On a successful canonical send, the local proxy adds `pii.triggeredFilters`, containing only filter IDs/names, when at least one node reports a hit. The CLI preserves it in its success JSON alongside the existing sent reference and reminder result. No-hit, blocked and failed sends receive no added PII field. The notice describes filtering of this local send attempt; it does not assert that a nonce-deduplicated canonical message was rewritten. No original values, matched substrings or plugin source are included.

Only normal identity-encoded JSON sent receipts are annotated. Unknown, malformed or unexpectedly large upstream bodies are preserved without inventing a successful receipt. Response buffering is bounded; existing stream-reset/timeout behavior remains in force.
