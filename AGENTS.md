# Alook
Alook's main purpose is to make the cli agent always on, and give it a email address.

## Navigation
- `plans/`: place your dev plans (gitignored, local only)
- `src/shared`: shared types, schema, queries, validators
- `src/web`: main Next.js app on Cloudflare Workers (D1 + R2); the independently built Blog app lives at `src/web/blog`
- `src/app`: local app CLI
- `src/daemon`: agent runtime and daemon CLI
- `src/email-worker`: inbound email Cloudflare Worker
- `src/ws-do`: WebSocket Durable Object worker

## MUST
- Don't write comment: comment may be outdated, code never. Unless the comment are specs and rules.
- Run `pnpm check` before delivery. It uses the canonical impact plan and normal repository checks. Use `pnpm check:full` for an explicit complete check; policy, unknown or unresolved inputs fall back to full automatically. Record actual selected and executed checks, not a blanket all-tests claim.
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
```
This updates every `src/*/package.json` and commits `release: vX.Y.Z`.
Add `--min-cli` when the release contains breaking changes that require users to update their CLI.
Add `--desktop` when the release includes desktop app changes that need a new build.
Add `--mobile` to trigger the existing iOS TestFlight upload and Android artifact workflow. Upload, store processing and review acceptance are separate outcomes.

After reviewing the commit:
```bash
git push origin main
```

This triggers:
- **CI** — the complete regression for release commits; ordinary main commits use key smoke checks and relevant artifacts
- **Auto-Tag & Release** — CI detects the `release: vX.Y.Z` commit message, creates the git tag, and creates a GitHub Release with generated changelog (`auto-tag-release.yml`)
- **@alook/app** → auto-published to npm via `publish-app.yml` (watches `src/app/package.json`)
- **@alook/daemon** → auto-published to npm via `publish-daemon.yml` (watches `src/daemon/package.json`)
- **CF Workers** → existing Cloudflare Git integration and watch rules determine deployments; GitHub CI is not an external deployment gate

### CI and browser tests

`.github/workflows/ci.yml` owns one canonical impact plan. PR and merge-queue checks run affected package checks plus key browser paths and matched feature groups. Core, policy, unknown and unresolved inputs retain full fallback. Ordinary main pushes run the small behavior smoke set and relevant artifacts; release commits and manual full dispatch run the full regression. See [CONTRIBUTING.md](CONTRIBUTING.md#ci-trigger-and-test-responsibilities) for the matrix and explicit commands.

Browser specs remain in `src/web/src/test/e2e-ui/`. Reuse the existing build-once artifact, shard runner and exact report verification. Keep stable `CI Gate` and `UI E2E Gate` checks; skipped out-of-scope jobs are expected, so do not require individual shards. No daily schedule is implied. Browser tests do not contribute to Vitest coverage. Codecov project and patch percentages are informational; neither hosted status nor the repository verifier enforces a percentage minimum. Failed tests, missing required instrumentation, malformed reports and upload errors still fail.

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
  - `QA tests` is required. For changed app behavior, name each necessary journey, its routes/testids and confirming backend signal. For tooling, name the real command/event, expected output and failure/cleanup signal. Reuse existing tests; do not invent a UI journey for a documentation or CI-only change. Name the assigned executor and state unrun or out-of-scope evidence explicitly.

## Behavioral tests and QA

- Select the lowest layer that proves the risk: pure/module tests for logic, DOM for visible state and events, native database/Worker/process integration for platform contracts, and browser E2E for key user journeys and changed integration boundaries.
- A `/c` behavior change needs the relevant existing key/feature journeys. A source-path touch alone does not require another complete browser run. CI/test-only changes need real tooling/selection checks, not an invented product journey.
- Use the task's assigned QA executor. If no executor is assigned and community runtime QA is needed, use `.claude/agents/alook-c-qa.md` with the plan's actual journey checklist. Do not duplicate an already assigned independent QA owner. Non-community surfaces use their relevant tests.
- Keep authentication, permission, message consistency, durable writes and process cleanup assertions. A QA FAIL/BLOCKED remains unfinished unless the owner explicitly accepts that scoped gap; discovery, compile, cached replay and actual runtime execution are different evidence.
- Add or change a test only when it independently proves changed behavior or an uncovered risk. Do not copy implementation text, mirror a complete internal props definition, add arbitrary line-count limits or manufacture a private exception to raise coverage. When removing or combining a test, state its former risk, the exact remaining executable guard and any coverage loss.
- Review test value again before freezing a candidate. Preserve distinct negative, concurrency and failure cases; two layers with different real boundaries are not duplicates merely because their names match. Do not weaken assertions, retries, budgets, source identity or cleanup to reduce runtime.

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

Posts live in `src/web/blog/src/content/<slug>.mdx`; images live in `src/web/blog/public/blog/<slug>/`.

### Frontmatter
Use `export const metadata = { ... }` — NOT YAML `---` frontmatter. The loader does a dynamic import and reads `mod.metadata`; MDX config has no `remark-frontmatter` plugin, so YAML blocks render as literal text and the post disappears from the listing.

Required fields (see `src/web/blog/src/lib/blog/types.ts`): `slug`, `title`, `date`, `author`, `excerpt`, `readingTime`. Missing any → post is skipped with a warning.

Same-topic article variants MUST use `tags: ["guides"]` in MDX metadata and belong in the supplementary `/guides` directory, not repeated main-Blog posts. See `src/web/blog/README.md` for placement and publishing rules.

### Images
- Path: `src/web/blog/public/blog/<slug>/<name>.<ext>`, referenced from MDX as `/blog/<slug>/<name>.<ext>`.
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
