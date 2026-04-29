# Alook
Alook's main purpose is to make the cli agent always on, and give it a email address.

## Navigation
- `plans/`: place your dev plans (gitignored, local only)
- `src/shared`: shared types, schema, queries, validators
- `src/web`: Next.js app on Cloudflare Workers (D1 + R2)
- `src/cli`: CLI + daemon
- `src/email-worker`: inbound email Cloudflare Worker
- `src/ws-do`: WebSocket Durable Object worker

## MUST
- run `pnpm typecheck`, `pnpm test` as the final check when you think the code is ready.
- service must be STATELESS! All the state must be in DB or local, never put important states in memory.
- scope the queries before, not check the ownership after. don't query data then check if the data belongs to a workspace, use workspace id ahead to query the data.

## Release — Unified Version Bump
All workspace packages share one version. Use `pnpm bump` to release:
```bash
pnpm bump 0.0.11      # explicit version (v prefix optional)
pnpm bump patch        # auto-increment patch/minor/major
```
This updates every `src/*/package.json`, commits `release: vX.Y.Z`, but does NOT push.
After reviewing the commit, `git push origin main` to trigger CI:
- **@alook/cli** → auto-published to npm via `publish-cli.yml` (watches `src/cli/package.json`)
- **CF Workers** → each module redeploys when its own `package.json` changes

## Plan-driven Development
- You must make a markdown plan at `plans/` before you implement any my request, otherwise I will reject your implementation.
- The `plans/` directory is gitignored — plans are kept locally and do not need to be committed or included in PRs.
- Remember to update the dev plan after you finish coding.
- When every task is completed, make sure you check the task checkbox in the corresponding plan.
- A plan should at least contain `features`/`show case`, `designs overview`, `new deps`, `TODOS`, sections.
  - always use the features/show case to present what you're going to build.
  - in `new deps` section, you must list all the new external dependencies that will be added.
  - use checklist in `TODOS` section, for each checkbox, you must have a clear description of what to do and list all the files that will be modified.
    - at the end of TODOS, you must include `test cases` sub section, use checklist format to list all the test cases that should be covered.

## Always WRITE/RUN TESTS!
- never report to me about your code changes without running tests first.
- always write tests for your code changes, only when your code changes are already covered by the current tests.

## Don't use plan MODE, try to write the plan md directly

## Database — Cloudflare D1 (SQLite) + Drizzle ORM

Schema lives in `src/shared/src/schema.ts` using `sqliteTable` from `drizzle-orm/sqlite-core`.
Queries use the shared query modules in `src/shared/src/queries/`.

Use Drizzle ORM operators for all queries. **Never use `sql` template literals** unless there is no ORM equivalent (atomic increment, upsert `excluded.*` references).

**Why:** Drizzle aliases tables internally. Raw SQL with hardcoded table/column names breaks silently.

### Good — ORM operators
```ts
// Aggregations
db.select({ messageCount: count(message.id) })
  .from(conversation)
  .leftJoin(message, eq(message.conversationId, conversation.id))
  .groupBy(conversation.id)

// Comparisons with ISO strings (D1 stores timestamps as TEXT)
gt(verificationCode.expiresAt, new Date().toISOString())
lt(verificationCode.attempts, 5)

// Null checks
isNull(agentRuntime.lastSeenAt)
isNotNull(agentTaskQueue.sessionId)
```

### Acceptable exceptions
```ts
// Atomic increment — no ORM equivalent
.set({ attempts: sql`${verificationCode.attempts} + 1` })
```

## Scrollbar

Always use the `thin-scrollbar` class alongside `overflow-y-auto` or `overflow-x-auto`. Never use bare overflow-auto without it.

```tsx
<div className="overflow-y-auto thin-scrollbar">...</div>
```

## UIUX
read @DESIGN.md