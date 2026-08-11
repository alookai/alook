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
- Don't write comment: comment may be outdated, code never. Unless the comment are specs and rules.
- run `pnpm typecheck`, `pnpm test` as the final check when you think the code is ready.
- service must be STATELESS! All the state must be in DB or local, never put important states in memory.
- scope the queries before, not check the ownership after. don't query data then check if the data belongs to a workspace, use workspace id ahead to query the data.
- respect others' works, don't reset any other git changes just because it's not done by you, others may working at the same time, never revert anything without asking the user.
  - don't stash others' works, you can wait, but stash others' work will cause many problems.

## Release — Unified Version Bump
All workspace packages share one version. Use `pnpm bump` to release:
```bash
pnpm bump 0.0.11      # explicit version (v prefix optional)
pnpm bump patch        # auto-increment patch/minor/major
pnpm bump patch --min-cli  # also update MIN_CLI_VERSION in src/web/wrangler.toml
pnpm bump patch --desktop  # trigger desktop build
pnpm bump patch --mobile   # trigger mobile build
```
This updates every `src/*/package.json` and commits `release: vX.Y.Z`.
Add `--min-cli` when the release contains breaking changes that require users to update their CLI.
Add `--desktop` when the release includes desktop app changes that need a new build.
Add `--mobile` when the release includes mobile app changes.

After reviewing the commit:
```bash
git push origin main
```

This triggers:
- **CI** — typecheck, lint, tests, coverage (uploaded to Codecov)
- **Auto-Tag & Release** — CI detects the `release: vX.Y.Z` commit message, creates the git tag, and creates a GitHub Release with generated changelog (`auto-tag-release.yml`)
- **@alook/cli** → auto-published to npm via `publish-cli.yml` (watches `src/cli/package.json`)
- **@alook/app** → auto-published to npm via `publish-app.yml` (watches `src/app/package.json`)
- **@alook/daemon** → auto-published to npm via `publish-daemon.yml` (watches `src/daemon/package.json`)
- **CF Workers** → each module redeploys when its own `package.json` changes

### E2E UI (browser tests)
Playwright browser E2E for the web UI lives in `src/web/src/test/e2e-ui/`. The `e2e-ui.yml` workflow starts for every PR and merge-queue check, then runs the browser matrix only when the diff touches `src/web`/`src/shared`/`src/ws-do`; blog-only and unrelated changes finish through the lightweight scope and gate jobs. The workflow also supports scheduled and manual full runs, but does not run after pushes to `main`. It is deliberately NOT tied to the release chain: a `release:` bump only changes version numbers, so gating there would test nothing, and the production web app deploys via Cloudflare's own Git integration (outside GitHub Actions) which a workflow gate can't block anyway. Run locally with `pnpm test:e2e-ui` (backs up and restores your local `.wrangler/state`).

> Branch protection may require the stable `UI E2E Gate` check. Do not require the individual `UI Playwright E2E (n/3)` matrix jobs, because skipped shards are expected for changes outside the UI scope.

## Plan-driven Development
- You must make a markdown plan at `plans/` before you implement any my request, otherwise I will reject your implementation.
- The `plans/` directory is gitignored — plans are kept locally and do not need to be committed or included in PRs.
- Remember to update the dev plan after you finish coding.
- When every task is completed, make sure you check the task checkbox in the corresponding plan.
- A plan should at least contain `features`/`show case`, `designs overview`, `new deps`, `TODOS`, `QA tests` sections.
  - always use the features/show case to present what you're going to build.
  - in `new deps` section, you must list all the new external dependencies that will be added.
  - use checklist in `TODOS` section, for each checkbox, you must have a clear description of what to do and list all the files that will be modified.
    - at the end of TODOS, you must include `test cases` sub section, use checklist format to list all the test cases that should be covered.
  - `QA tests` section is REQUIRED. It must be a checklist of end-to-end user journeys the `alook-c-qa` agent will drive after implementation lands. For each journey: name it, list the routes/testids it exercises, and state the backend signal (D1 row, WS frame, worker log) that proves it worked. This section is the QA agent's brief — it will fail if the section is missing or vague.

## QA after every new /c feature
- After any change that touches `src/web` (especially the `/c` surface), `src/ws-do`, or `src/shared` community queries/schema, you MUST launch the `alook-c-qa` subagent to verify the feature end-to-end before reporting the task complete. Typecheck + unit tests are necessary but not sufficient — a green build with a broken user journey is still a broken feature.
- The QA agent lives at `.claude/agents/alook-c-qa.md`. Invoke it via the Agent tool with `subagent_type: alook-c-qa` and hand it the `QA tests` checklist from the plan. It boots (or reuses) the local dev stack, drives the browser, correlates against D1 + WS + worker logs, and reports PASS/FAIL/BLOCKED with evidence.
- If the QA agent returns FAIL or BLOCKED, treat that as an unfinished task — fix the defect and re-run the QA agent. Do not mark the plan checkbox complete on a failing journey. If a journey is genuinely out of scope for a change, say so in the report and skip it explicitly, don't silently drop it.
- The QA agent is scoped to `/c` (community). For changes elsewhere in `src/web` (blog, marketing, calendar, etc.) it is not the right tool — run the relevant unit/E2E tests directly.

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

## Blog posts

Posts live in `src/web/src/content/<slug>.mdx`; images live in `src/web/public/blog/<slug>/`.

### Frontmatter
Use `export const metadata = { ... }` — NOT YAML `---` frontmatter. The loader does a dynamic import and reads `mod.metadata`; MDX config has no `remark-frontmatter` plugin, so YAML blocks render as literal text and the post disappears from the listing.

Required fields (see `src/web/src/lib/blog/types.ts`): `slug`, `title`, `date`, `author`, `excerpt`, `readingTime`. Missing any → post is skipped with a warning.

### Images
- Path: `src/web/public/blog/<slug>/<name>.<ext>`, referenced from MDX as `/blog/<slug>/<name>.<ext>`.
- Naming: short semantic names (`hero.png`, `timeline.png`, `workflow-1-dev-team-pipeline.svg`). No date prefix. Don't repeat the slug — the parent directory already carries it.
- Format: `png` for photos/screenshots, `svg` for diagrams, `webp` when compression matters. Pick one; don't mix formats for the same purpose in one post.
- CI accepts `.jpg`, `.jpeg`, `.png`, `.svg`, and `.webp`; each referenced image must be at most 2 MiB.
- **Safe margin (anti-crop):** keep ≥8% of the shorter side (and ≥64px) empty cream/bg padding on all four edges. Blog MDX applies `rounded-lg` on `img`, so ink or labels flush to the canvas edge get clipped. Do not stretch-crop heroes into OG size if that eats the margin — letterbox on `#FEFDFB` instead.

## Scrollbar

Always use the `thin-scrollbar` class alongside `overflow-y-auto` or `overflow-x-auto`. Never use bare overflow-auto without it.

```tsx
<div className="overflow-y-auto thin-scrollbar">...</div>
```

## UIUX
read @DESIGN.md
