# TanStack official composition spike report

## Decision

The locked package family can replace the current custom REST-to-collection publication protocol for the proven eager and expanding-prefix resources. The accepted composition is:

```text
scoped REST API
  -> queryCollectionOptions (transport, request identity, refetch)
  -> persistedCollectionOptions (OPFS restore + committed transactions)
  -> TanStack DB collection (one normalized browser row owner)
  -> live query (UI projection)

exact scoped WS fact -> writeBatch/writeUpsert/writeDelete
gap/reconnect/unknown outcome -> one coalesced utils.refetch barrier
```

This is a spike result, not approval for a production migration. Keep Next App Router. Do not add a D1/DO sync table, custom revision, outbox, or a replacement router.

## Evidence

The Playwright suite runs six real-Chromium scenarios against actual OPFS SQLite and Vite WebSocket frames:

| Scenario | Observed result |
|---|---|
| cold/offline rebuild | online REST rows persisted; a new offline runtime exposed the cached server rows while the refresh promise rejected |
| exact WS + duplicate | absolute server/message upserts used official direct-write APIs; replay remained one row per key |
| freshness burst | three real Vite WS frames classified as reconnect, gap, and unknown entered the event listener, shared one in-flight `utils.refetch()`, and settled after the authoritative row was visible |
| on-demand messages | channel equality, `seq desc`, and expanding limit reached `loadSubsetOptions`; indexed live queries rendered windows `[6,5]` then `[6,5,4,3]` |
| permission/account | revoke deleted the inaccessible server and channel messages; replacement built a beta-scoped OPFS/runtime with no alpha rows |
| multi-tab/bfcache | a local direct write—not a WS broadcast—reached the peer through `BrowserCollectionCoordinator`; dispatched `PageTransitionEvent` events proved the installed listener ignores `persisted=false` and closes/rebuilds database, coordinator, QueryClient, collections, and live query for `persisted=true` before further writes |

Run result:

```text
pnpm exec playwright test --config spikes/tanstack-official-composition/playwright.config.ts --workers=1
6 passed
```

Repository verification also passed: `pnpm typecheck`, `pnpm test` (including 8,644 web tests, 786 agent-driver tests with four skipped, and 349 CI-script tests), and the required independent runtime QA. Independent QA repeated the focused command and returned PASS 6/6.

The two-tab test deliberately calls a local direct write in one page. This prevents the Vite WS broadcast from creating a false coordinator pass.

## Capability gaps and operational constraints

### Opaque cursor helper is absent from the published package

The current Query Collection documentation describes `createCursorPager`, but `@tanstack/query-db-collection@1.2.15` does not export it and its published source does not contain it. Locked `LoadSubsetOptions` does include `offset`, but `parseLoadSubsetOptions()` omits it; the harness reads `context.meta.loadSubsetOptions.offset` directly. The browser test still proves only predicate/order/expanding-prefix demand, not arbitrary offset windows. It does not invent an application cursor table or pager.

The current newest/older/newer/anchor message API cannot be migrated unchanged until one of these happens:

1. a compatible official release exports the documented pager; or
2. the server exposes an offset/window contract that Query Collection can translate directly.

This is a stop condition for the production message cutover, not a reason to restore the custom sync protocol.

### OPFS database names must remain short

With the locked WASQLite/OPFS stack, long generated database names failed at `sqlite3_open_v2`; short account-scope names opened consistently. A production runtime should hash or otherwise bound the account namespace and test its maximum length instead of embedding verbose labels.

### Worker bundling must preserve the package worker URL

Vite dependency pre-bundling rewrote the OPFS worker to a missing asset path. The standalone config excludes `@tanstack/browser-db-sqlite-persistence` from `optimizeDeps`, allowing the package worker URL to load. A production bundler integration needs an equivalent worker-asset test.

### Persisted page restore requires full reconstruction

The reliable lifecycle is to close subscriptions, live queries, collections, coordinator, database, and QueryClient on persisted pagehide, then create all of them again on persisted pageshow. Reusing the old worker/runtime is not supported by the proven path.

## Production keep/delete decision

Keep:

- authorized D1/REST contracts and mutation semantics;
- TanStack Query as transport/freshness under Query Collection;
- TanStack DB schemas, collections, and live projections;
- OPFS persistence and `BrowserCollectionCoordinator`;
- Next App Router for URL identity;
- Zustand only for presence, composer/upload, viewport, modal, timer, and explicit device-preference state.

Delete after resource-by-resource parity:

- manual query-function publication and collection-row Query shadows;
- custom canonical revisions, pending operations, write contexts, snapshot tokens, receipts, and binding waits;
- Query observer leases used only to sustain publication;
- dual Query/DB authoritativeness comparisons;
- entity truth and access/freshness ownership in Zustand;
- the no-op sync installation lifecycle and obsolete registry globals.

Exact facts should map through a small event-to-collection write layer. Non-exact events should only select and coalesce an authoritative refetch. The full evidence-based delete matrix and staged order are in `architecture-audit.md`.
