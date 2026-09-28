# TanStack official composition spike

This standalone browser harness proves the official TanStack composition without importing it into the Next.js production graph:

```text
REST -> queryCollectionOptions -> persistedCollectionOptions -> OPFS
WS exact facts -> collection.utils.writeBatch
gap/reconnect/unknown -> coalesced collection.utils.refetch
TanStack DB live query -> rendered servers/messages
```

It uses a real Chromium OPFS database, the package's WASQLite worker, Vite's real WebSocket transport, and `BrowserCollectionCoordinator`. The fake REST service is deterministic and lives only in the Vite plugin.

## Run

From `src/web`:

```bash
pnpm exec playwright test --config spikes/tanstack-official-composition/playwright.config.ts --workers=1
```

For manual inspection:

```bash
pnpm dlx vite@7.1.7 --config spikes/tanstack-official-composition/vite.config.ts --host 127.0.0.1 --port 4177
```

Then open `http://127.0.0.1:4177/?db=manual-1`. Keep `db` short: the locked WASQLite/OPFS stack returns `sqlite3_open_v2` for sufficiently long database names.

## Scope

The harness covers cold/offline cache restore, eager server truth, on-demand ordered expanding message windows, exact and duplicate WS facts, reconnect/gap/unknown Vite WS signals entering a coalesced freshness refetch, permission deletion, account-scoped runtime replacement, direct-write propagation between two tabs, and `PageTransitionEvent` listener-driven persisted-page runtime reconstruction.

See [report.md](./report.md) for the decision and capability gaps. See [architecture-audit.md](./architecture-audit.md) for the current-system ownership audit and migration/delete matrix.
