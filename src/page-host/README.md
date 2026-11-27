# Alook Page host

This private Worker builds the real Open Artifact Cloudflare host and editors from the immutable revision in `upstream.json`. Alook owns the independent Page resource and its message associations. Current access to any association grants reader access; its publishing bot can manage an unused upload. The host has no independent public share, login, agent connection or feedback queue.

## Build and local proof

From the repository root:

```sh
pnpm --filter @alook/page-host build
pnpm --filter @alook/page-host test
pnpm --filter @alook/page-host test:native
```

The first build fetches the pinned Git revision and runs its locked `npm ci --ignore-scripts`. It builds eight editors plus the generic Page frame. `.cache/` and `dist/` are generated. `OPEN_ARTIFACT_SOURCE` may point to a local checkout at the exact pin; the preparation script creates a separate clone without hardlinks. Unknown local changes to a patched source seam fail the build.

`test:native` runs the actual bundled Worker, D1 and SQLite Durable Objects in Miniflare. Its Alook authorization callback is synthetic: it proves the host boundary, not the complete Alook application. It builds the distributable CLI and verifies directory validation/filtering before network upload, actual archive import, cookie authentication, exact framing policy, real Shell Ask author mapping, independent concurrent source contexts, removed-source feedback denial, authorized forwarding-bot edits, optimistic write conflicts, safe import retries and last-access live revocation. It closes its HTTP servers and disposes workerd. `KEEP_NATIVE_PAGE_HOST=1` keeps the synthetic fixture on ports 49126/49127 for an assigned browser executor; stop that exact process when done.

For local app integration, copy `.dev.vars.example` to `.dev.vars`, set random development secrets and use the same `ALOOK_PAGE_SERVICE_KEY` in Web. Start the host alongside Web using the shared Wrangler registry. Configure Web's Page origin and the host's exact Web origin/embedding origins consistently.

## Publish and update

A bot uses the existing message command and upload path:

```sh
alook page upload --dir /absolute/artifact-directory --cover /absolute/cover.png
alook message send --target /example#1234/general --page page_ID_FROM_UPLOAD --remind-after 5m --stdin <<'PAGE_MESSAGE'
Please review this Page.
PAGE_MESSAGE
```

Upload an artifact directory with its required homepage cover image once using `page upload --dir <directory> --cover <image>` and pass the returned `page_id` to `message send --page <page_id>` across one or more channels. The CLI validates the directory before network access, excludes `.git`, `node_modules` and hidden unrelated files, rejects symlinks, then constructs the upstream ZIP with one enclosing folder. That folder contains `.artifact.json` and the native artifact files. A generic Page has `{"type":"page","title":"Example","capabilities":{"comments":{}}}` and `index.html`. Upstream exports for the other supported types retain their native format. Archives are limited to 16 MiB compressed, 32 MiB expanded and 2,000 files.

The server registers the archive as an independent Page before advertising a card. Bot plus archive attachment id determines the Page id; repeated registration never replaces live edits. The normal message, trusted embed and many-to-many message association commit in one D1 batch. Reusing a Page id requires its publisher or current reader access, and makes no new upload or import. All messages point to the same live artifact. Deleting a message removes only its association. Removing all readable associations revokes reader access and live connections; the publisher retains its independent resource. The archive attachment stays referenced by the resource, without adding a visible ZIP block to its messages.

Use `alook page --id <page-id> --stdin` for native operations. For example:

```json
{"kind":"actions"}
{"kind":"manifest"}
{"kind":"read","path":"index.html"}
{"kind":"write","writes":[{"path":"index.html","content":"BASE64","if_match":"ETAG_FROM_READ"}]}
{"kind":"action","name":"NATIVE_EDITOR_ACTION","args":{}}
```

`actions` returns the pinned native editor action names and JSON schemas; use those schemas for `action` arguments. `read` returns base64 plus its etag; `--out <new-path>` creates a local file without replacing an existing file. File reads and writes are limited to 1 MiB per file through this JSON interface. A write requires `if_match` (`null` means the path must be absent). Conflicts return the upstream result; read and reconcile before another write. Database editor documents use their upstream actions, because Open Artifact protects their files from raw writes. Authorized bot readers can use native operations; edits require communication access to at least one readable association. The publishing bot can manage its independent upload. No second publication replaces an existing Page.

`alook page list [--limit 1..100] [--cursor <nextCursor>]` lists resources created by the current bot, including unused uploads. It returns `total`, metadata and each resource’s association count. Queries start at the bot’s compound index; counts start at the selected Page ids.

`alook page delete --id <page-id>` permanently deletes a resource created by that bot, destroys its cloud files/catalog and closes live connections, then removes its Alook associations. Cloud failure retains the resource record so the same creator can retry; it does not report success. Reader access does not permit whole-resource deletion. Original archive uploads follow the existing attachment retention policy.

## Authority and deployment

Web and this Worker call each other through service bindings and a separate random key of at least 32 bytes. Viewer tickets use Web's existing verification table, expire after 60 seconds and are consumed once. They enter the bootstrap through a URL fragment that is removed before the exchange request. They are not durable access grants. OA session users derive from immutable Alook account ids; display names never select an account. HTTPS iframe sessions use `HttpOnly; Secure; SameSite=None; Partitioned` cookies.

Only the trusted Shell receives an exact Alook `frame-ancestors` allowlist. Artifact content remains on upstream per-viewer content origins. Room request access caching is disabled. Live connections are rechecked after five seconds between completed checks, only while a room has holders; one room check deduplicates its principals. Permission callbacks have a five-second timeout; failures close connections. Refresh time also depends on the number of distinct accounts in that room. Revocation cannot erase bytes already loaded by a browser. This check adds at most 12 permission callbacks per minute per active room/account, plus normal request checks; it does no whole-site polling.

Native feedback is stamped with the authenticated account at the frame/type-server boundary and delivered synchronously through Web's ordinary human message door. The opening message id is bound into the one-use viewer ticket and native signed page token, independently for each window. Feedback validates that exact association and its current read/communication access; it mentions the opening message’s bot author. Missing source context is accepted by Web only when exactly one readable association exists. A removed source never falls back to a different conversation. Feedback failures remain failures, with no fallback agent inbox/outbox. Repeated native comment delivery uses the ordinary message nonce.

`wrangler.jsonc` intentionally contains a placeholder D1 id and local origins. Production requires an approved database, app origin, distinct wildcard content origin, exact Alook origins, secrets and matching service bindings. Apply the Web migration and configure the host before enabling publication. Building or merging does not deploy or provision resources. Production cross-site cookie/browser QA and account deployment remain separate from the synthetic local proof.

The source overlays adapt service binding fetch, authenticated feedback identity, synchronous Alook delivery, active connection revocation and idempotent initial import. The upstream Apache-2.0 license is retained in `LICENSE.open-artifact` and copied into built assets. No upstream source cache is committed.
