# Backend query scan check

Run `pnpm check:db-queries` after `pnpm install --frozen-lockfile`. This runs the checker’s own tests, then the existing Node backend test projects with SQL collection enabled. It uses one worker and no production connection. The CI job runs the same command and keeps its reports on failure. Full local runs remain subject to the owner's CPU constraint; pass the relevant test files for scoped local work and leave the broad run to CI.

```sh
pnpm check:db-queries community-bot.test.ts machine-plan-limits.integration.test.ts
pnpm check:db-queries --require-complete
```

Before a complete backend run, build existing prerequisites with `pnpm --filter @alook/agent-driver build`, as CI does. Normal test commands do not enable instrumentation.

The command writes `.ci/db-query-check/report.json` and `report.md`. It exits nonzero for detected business table/index scans, SQL compilation errors, failed tests, or missing/empty capture. `--require-complete` also fails for uncovered query sites or unattributed observed SQL. Without that flag, a scan-free partial run says **observed-queries-passed-with-coverage-gaps**, not “all DB queries passed”. The JSON includes every discovered site, actual observed SQL shapes, bind types, query plans, source/migration/checker hashes, SQLite version, and uncovered sites.

## What it checks

The TypeScript checker enumerates DB method calls across shared, Web, Auth, WS, email/queue workers, daemon and app sources, excluding tests and generated files. DB declaration types distinguish ORM calls from Array/Map operations; unresolved supported-method receivers remain explicit candidates; receiver variable names do not determine inclusion. Retired code stays in this inventory. An unexecuted or unresolved source path is not certified safe.

Test-only Vite instrumentation attaches a construction-site identity to real Drizzle builders. Only that exact identity can mark a source site observed; stack file/line ranges are diagnostic and cannot certify a neighboring branch. It does not eagerly compile SQL or evaluate generated defaults twice. Native better-sqlite3 and node:sqlite statement methods capture actual bound SQL when tests execute it, including raw D1 adapters backed by these drivers. Queries seen only by mocks, remote Worker processes, untested branches and unmatched deferred execution remain gaps. Third-party generated SQL is analyzed when reached; source enumeration cannot list a library's unseen dynamic queries.

The checker applies repository migrations to a separate in-memory SQLite and compiles the captured SQL with its real parameters. It does not execute product writes in that analysis database. Parameters stay in a private temporary directory during collection and are removed afterward; uploaded reports retain binding types and normalized SQL without literal values.

[Cloudflare recommends EXPLAIN QUERY PLAN to verify index use](https://developers.cloudflare.com/d1/best-practices/use-indexes/). The checker retains that plan, then resolves physical B-tree cursors to schema root pages using EXPLAIN bytecode. It detects full table and full index iteration, count shortcuts and unqualified Clear deletion without guessing table aliases. JSON virtual inputs and ephemeral/CTE cursors are different from persisted tables.

## Conditions and limits

- SEARCH is also checked: an index constrained only by broad flags such as isBot on user-owned data does not prove business scope. The ownership relation follows schema foreign keys to user. A positive row limit is accepted for such an index stream only when bytecode proves that every visited row reaches output and decrements that limit; a residual filter that can skip output prevents that proof. The checker still rejects physical full SCANs.
- A recognized constant guard that halts before any database access, including `WHERE 1=0`, is recorded as proof that the displayed SCAN is not executed.
- FK scans remain part of actual parent-write analysis. An immediate counter known to start at zero may skip its guarded block; a prior possible increment, a trigger that can increment counters, or pending deferred work prevents that assumption. Plain single-row INSERT parent checks can also use actual indexed fixture parent lookups; no value is written to reports. Read-only triggers do not invent a counter increment. Native transaction/defer context is retained for analysis. Parent DELETE and key UPDATE are not exempt.
- Additional schema-wide FK lookup probes are an audit of potential work, including retired tables. They are listed separately and do not claim that an actual parent operation executed them. They do not alone fail the observed-operation gate or justify adding structures to retired features.
- Unrecognized conditions remain conservative potential hazards. There is no SCAN allowlist, WHERE/LIMIT shortcut, source-query success baseline or automatic retry.
- Local plans are structural evidence, not production D1 latency or row counts. Captured bindings and branches are finite examples, not exhaustive input coverage.
- [SQLite documents that EXPLAIN internals can change](https://www.sqlite.org/opcode.html). The checker validates SQLite 3.53.2, the locked better-sqlite3 build. Another version fails explicitly until compatibility and the real before/after cases are validated.

The original issue282 activation SQL is retained as a dummy-data regression: its message-driven anti-join must be rejected even though it has WHERE conditions. The repair's real query tests supply the positive acceptance. The tooling also invokes the real message, forum, channel and server deletion functions so a broad SEARCH guard is not hidden behind a mocked DB. The checker does not replace those permission, atomicity or race assertions.
