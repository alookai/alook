# Alook Page host

This private Worker builds the real Open Artifact Cloudflare host and editors from the immutable revision in `upstream.json`. The Alook message is the sole access authority. The host has no independent public share, login, agent connection or feedback queue.

## Build and local proof

From the repository root:

```sh
pnpm --filter @alook/page-host build
pnpm --filter @alook/page-host test
pnpm --filter @alook/page-host test:native
```

The first build fetches the pinned Git revision and runs its locked `npm ci --ignore-scripts`. It builds eight editors plus the generic Page frame. `.cache/` and `dist/` are generated. `OPEN_ARTIFACT_SOURCE` may point to a local checkout at the exact pin; the preparation script creates a separate clone without hardlinks. Unknown local changes to a patched source seam fail the build.

`test:native` runs the actual bundled Worker, D1 and SQLite Durable Objects in Miniflare. Its Alook authorization callback is synthetic: it proves the host boundary, not the complete Alook application. It verifies publication, cookie authentication, exact framing policy, real Shell Ask author mapping, optimistic write conflicts and safe publication retries. It closes its HTTP servers and disposes workerd. `KEEP_NATIVE_PAGE_HOST=1` keeps the synthetic fixture on ports 49126/49127 for an assigned browser executor; stop that exact process when done.

For local app integration, copy `.dev.vars.example` to `.dev.vars`, set random development secrets and use the same `ALOOK_PAGE_SERVICE_KEY` in Web. Start the host alongside Web using the shared Wrangler registry. Configure Web's Page origin and the host's exact Web origin/embedding origins consistently.

## Publish and update

A bot uses the existing message command and upload path:

```sh
alook message send --target /example#1234/general --page /absolute/page.zip --remind-after 5m --stdin <<'PAGE_MESSAGE'
Please review this Page.
PAGE_MESSAGE
```

The zip contains the upstream artifact files, including `.artifact.json`, in its root. A generic Page has `{"type":"page","title":"Example","capabilities":{"comments":{}}}` and `index.html`. Upstream exports for the other supported types retain their native format. Archives are limited to 16 MiB compressed, 32 MiB expanded and 2,000 files.

The server imports before advertising the card. The normal message, trusted embed and Page/source binding commit in one D1 batch. Bot plus send nonce determines the Page id; transport retries return the existing artifact and never replace live edits. Imported but unadvertised artifacts remain inaccessible until the source binding commits.

Use `alook page --id <page-id> --stdin` for native operations. For example:

```json
{"kind":"actions"}
{"kind":"manifest"}
{"kind":"read","path":"index.html"}
{"kind":"write","writes":[{"path":"index.html","content":"BASE64","if_match":"ETAG_FROM_READ"}]}
{"kind":"action","name":"NATIVE_EDITOR_ACTION","args":{}}
```

`actions` returns the pinned native editor action names and JSON schemas; use those schemas for `action` arguments. `read` returns base64 plus its etag; `--out <new-path>` creates a local file without replacing an existing file. File reads and writes are limited to 1 MiB per file through this JSON interface. A write requires `if_match` (`null` means the path must be absent). Conflicts return the upstream result; read and reconcile before another write. Database editor documents use their upstream actions, because Open Artifact protects their files from raw writes. The publishing bot must still have access to the original conversation. No second publication replaces an existing Page.

## Authority and deployment

Web and this Worker call each other through service bindings and a separate random key of at least 32 bytes. Viewer tickets use Web's existing verification table, expire after 60 seconds and are consumed once. They enter the bootstrap through a URL fragment that is removed before the exchange request. They are not durable access grants. OA session users derive from immutable Alook account ids; display names never select an account. HTTPS iframe sessions use `HttpOnly; Secure; SameSite=None; Partitioned` cookies.

Only the trusted Shell receives an exact Alook `frame-ancestors` allowlist. Artifact content remains on upstream per-viewer content origins. Room request access caching is disabled. Live connections are rechecked after five seconds between completed checks, only while a room has holders; one room check deduplicates its principals. Permission callbacks have a five-second timeout; failures close connections. Refresh time also depends on the number of distinct accounts in that room. Revocation cannot erase bytes already loaded by a browser. This check adds at most 12 permission callbacks per minute per active room/account, plus normal request checks; it does no whole-site polling.

Native feedback is stamped with the authenticated account at the frame/type-server boundary and delivered synchronously through Web's ordinary human message door. The original source conversation and publishing bot come from the Page binding. Feedback failures remain failures, with no fallback agent inbox/outbox. Repeated native comment delivery uses the ordinary message nonce.

`wrangler.jsonc` intentionally contains a placeholder D1 id and local origins. Production requires an approved database, app origin, distinct wildcard content origin, exact Alook origins, secrets and matching service bindings. Apply the Web migration and configure the host before enabling publication. Building or merging does not deploy or provision resources. Production cross-site cookie/browser QA and account deployment remain separate from the synthetic local proof.

The source overlays adapt service binding fetch, authenticated feedback identity, synchronous Alook delivery, active connection revocation and idempotent initial import. The upstream Apache-2.0 license is retained in `LICENSE.open-artifact` and copied into built assets. No upstream source cache is committed.
