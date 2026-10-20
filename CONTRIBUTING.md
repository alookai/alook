# Contributing to Alook

Thanks for your interest in contributing to Alook. This guide covers everything you need to get started.

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 9
- **Bun** (for CLI development)

## Setup

```bash
git clone https://github.com/alookai/alook.git
cd alook
pnpm install
pnpm db:migrate
pnpm dev
```

This starts the web app and workers locally. To work on the CLI separately:

```bash
pnpm dev:cli
```

## Project Structure

Alook is a monorepo with nine packages:

| Package | Location | What it does |
|---------|----------|-------------|
| `@alook/web` | `src/web` | Next.js dashboard, REST API, auth, database |
| `@alook/shared` | `src/shared` | Types, constants, DB schema, validation |
| `@alook/email-worker` | `src/email-worker` | Inbound email parsing and storage |
| `@alook/ws-do` | `src/ws-do` | Real-time WebSocket channels |
| `@alook/app` | `src/app` | One-command local bootstrap (`npx @alook/app onboard`) |
| `@alook/daemon` | `src/daemon` | Host-side runtime backend, process manager, credential proxy |
| `@alook/desktop` | `src/desktop` | Desktop app (Tauri) |
| `@alook/queue-worker` | `src/queue-worker` | Handles versioned bot-wake and mobile-push tasks |

## Making Changes

### 1. Branch off main

```bash
git checkout -b feat/your-feature
```

### 2. Write your code

A few ground rules:

- **Scope DB queries by workspace ID** — every query must be scoped. This is a security boundary.
- **Services are stateless** — all state belongs in the database or on disk, never in memory.
- **Use Drizzle ORM** — no raw SQL unless there's no ORM equivalent.
- **Write tests** — only skip if the change is already covered by existing tests.

### 3. Validate before pushing

```bash
pnpm typecheck
pnpm lint
pnpm test
```

All three must pass. A pre-commit hook runs lint and test automatically.

### 4. Open a PR

- Target the `main` branch
- Fill out the PR template — link the issue, describe what changed, check the impact areas
- CI runs typecheck, lint, tests (Ubuntu + Windows), e2e, build, and Lighthouse

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
TYPE(SCOPE): description
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

**Scopes:** `shared`, `web`, `cli`, `email-worker`, `ws-do`, `deps`, `config`

Examples:

```
feat(web): add agent creation page
fix(cli): resolve auth token refresh race condition
chore(deps): update dependencies
```

Use the body to explain *what and why*, not how. Reference issues with `Closes #123`.

## Community conversation maintenance contract

Forums are channels with a different presentation. Share account/access qualification, canonical entities, message commands and reading ownership. Keep post ID windows, tag filters and retained view lifetimes where their consumers require them.

### State owners and cache coverage

| State | Owner and contract |
|---|---|
| Canonical channel, message, membership and read facts | [community DB](src/web/src/lib/community-db/sync.ts). HTTP and WS publish through the same qualified writers. Transport windows contain IDs, cursors and page boundaries. |
| Entry qualification and selected window | [conversation-entry](src/web/src/lib/community/conversation-entry.ts) and [use-conversation-entry](src/web/src/hooks/community/use-conversation-entry.ts). Bind account, channel/server, access generation, original request and Query identity. A cached entity or anchor parameter alone does not prove target coverage. |
| Local reading and PUT confirmation | [read-coordinator](src/web/src/hooks/community/read-coordinator.ts). Keep exact accepted message ID/sequence and original authority. Normal viewport progress survives release, ACK and failed canonical readback; cancel-uncommitted opener handoff does not supply a viewport position. |
| Initial viewport and active user input | [use-scroll-anchor](src/web/src/hooks/community/use-scroll-anchor.ts). A fresh ordinary entry can consume a newer qualified local target once. Explicit message/sequence navigation wins; active entries and retained parent resume keep their original position ownership. |
| Navigation completion and role display | [navigation controller](src/web/src/components/community/shell/use-community-navigation-controller.ts), [shell frame](src/web/src/components/community/shell/shell-frame.tsx), [channel route](src/web/src/components/community/channels/channel-route.tsx) and [member VM](src/web/src/components/community/members/channel-member-view-model.tsx). The existing navigation owner completes URL publication plus structural frame; the existing server-role authority supplies display facts. |

Use a qualified cached window only when its IDs and complete canonical entities cover the requested target. Display and position from that coverage immediately while an ordinary entry refresh runs in the background. A missing ordinary-entry key does not retire another valid entry's qualification. Otherwise obtain coverage through the existing entry/window request. Preserve valid older windows and the actual selected Query's pages/page parameters. Landing reconciliation carries its sequence high waterline through the existing [reconnect owner](src/web/src/hooks/community/community-ws/reconnect-messages.ts), including a newer requirement that arrives during an older read.

Freshness and retention are different. Entry and message-window options own stale/GC policy; [query-persister](src/web/src/lib/query-persister.ts) owns the bounded persisted closure and restore eligibility. A prior visit, restored entity or fresh metadata does not establish an available, qualified landing window. Account retirement and channel/parent access generation changes retire original authority before reuse; never recapture new permission for old work or carry an old generation's maximum into the new one.

Presence revisions protect confirmed rows from older snapshot omissions. An existing row may accept an in-flight snapshot when only its presence revision is newer; a real newer field update retains the existing whole-row protection.

### Request, merge and action boundaries

Capture account, target and allowed lifetime before an async command. Keep that qualification through transport, authentication effects and canonical publication. View-dependent actions also keep their original view guard. An accepted send has its existing account/target lifetime across view changes; that does not authorize old UI completion or a stale retry.

| Action | Required merge/display boundary |
|---|---|
| Entry, pagination, explicit jump, present | Existing Query/window owner reads and reconciles IDs. Keep the selected window and captured canonical read snapshot; do not wait for all background synchronization or clear unrelated caches. |
| Read | Real visible reading admits the intent. Local progress, server-confirmed sequence and canonical read snapshot are separate. Local and confirmed progress each advance monotonically within a valid generation; jumping to older content changes the viewport only. |
| Send, edit, reaction, pin, mark, tags and thread actions | Existing command/transaction owners publish their qualified result. Preserve field revisions, original optimistic rollback and newer WS facts; one command's completion cannot settle another view or overwrite a newer field. |
| First-body edit and forum preview | The shared accepted content writer mirrors full content only for exact child `firstMessageId`. Mirror optimistic content in the same native transaction. HTTP acceptance of another field does not authorize rejected content. Title/opener, later replies and missing first-body identity do not grant preview ownership. Keep the forum ID window. |
| Back and resumed-parent role display | `hasPendingParentReturn` derives the accepted return from the original resume intent and exact pending target/state. Repeated Back merges until URL and structural frame both complete; the next Back then goes higher. Ordinary forward cancellation remains. `roleDisplayAllowed` can use qualified cached own role for a ready/hydrated resumed forum; member reads and action source guards still require their original access/current view. |

Preserve each action's existing confirmation model: Pin/Mark update after ACK; forum posting uses two HTTP commands and does not promise an atomic post transaction. Ordinary message deletion is not a supported action. Post archive/deletion keep their existing qualified command and retirement paths.

### Display evidence and regressions

[use-messages](src/web/src/hooks/community/use-messages.ts) exposes `historyStartKnown` only when the selected qualified page explicitly confirms no older history. Leading and empty heroes require that evidence. No selected page means unknown history, even if live rows are visible. Content visibility and read-position readiness remain separate; showing content alone does not acknowledge reading. `initialPositionMessageId` supplies only the one-shot local landing, without rewriting canonical snapshot/NEW or fabricating server confirmation.

The target root in [CommunityPendingFrame](src/web/src/components/community/shell/community-pending-frame.tsx) paints the theme background over retained content during cross-scope loading. Preserve old DOM/inert and drawer-exit ownership. Opaque coverage does not require another MobilePage, transition state, request or fixed animation wait.

Keep these existing regression entry points when changing the contract:

- Reading/coverage and canonical roles: `use-conversation-entry.dom.test.tsx`, `read-coordinator.test.ts`, `use-read-observer.dom.test.ts`, `use-messages.window.dom.test.tsx`, `use-scroll-anchor.repin.dom.test.ts`, `use-servers.dom.test.ts` under `src/web/src/hooks/community/`.
- Boundary display: `message-list-row.dom.test.ts`, `message-list-view.dom.test.ts`, `message-list.older-load.dom.test.ts` under `src/web/src/components/community/messages/`.
- Content/commands: `forum-preview-live-edit.dom.test.ts`, `accepted-send-lifecycle.dom.test.ts` and `mutations/message-field-owner.dom.test.tsx` under `src/web/src/hooks/community/`.
- Navigation/role/target container: `shell-frame.dom.test.ts`, `use-community-navigation-controller.dom.test.ts`, `community-pending-frame.dom.test.ts`, `channel-route.text-scroll-target.dom.test.ts` and `channel-member-view-model.dom.test.ts` in their corresponding component directories.

Use the normal Web Vitest configs and repository gates. Real QA must also bind target/scope, actual input, visible landing and backend read/message evidence. HTTP body completion, canonical publication and final viewport are different events; component/system-event controls do not establish native bridge behavior.

## Testing

- **Framework:** Vitest
- **E2E:** Playwright (web package)
- **Run all:** `pnpm test`
- **Run by package:** `pnpm test:shared`, `pnpm test:cli`, `pnpm test:web`, `pnpm test:e2e`

Tests run on both Ubuntu and Windows in CI.

### UI browser E2E and formal local QA

Run `pnpm test:e2e-ui` from the repository root. Local runs and CI use the
same built Worker graph: one pinned Wrangler loads Web, WS and the real
queue worker; Blog runs separately with its own storage. The public ingress
is `http://localhost:3000`, with Web on port 3001 and Blog on port 3002. Stop other dev
stacks before this run. The runner does not reuse a stack based on health
responses and does not stop listeners owned by another worktree.

Prepare local Worker variables before running. If the files do not exist,
copy `src/web/.dev.vars.example` to `src/web/.dev.vars` and
`src/queue-worker/.dev.vars.example` to `src/queue-worker/.dev.vars`.
Fill in local `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY`; the queue worker
must use the same encryption key as Web. Keep these files private. The Web
Worker variables must also include:

```dotenv
BETTER_AUTH_URL=http://localhost:3000
NODE_ENV=development
DEV_WS_DO_URL=http://localhost:3000
```

`NODE_ENV` here is a local Worker variable used by authentication through
`env.NODE_ENV`; it is not a build command override or a queue transport
switch. Next compiles the built Web producer's `process.env.NODE_ENV` as
`production`, so this entry uses `TASK_QUEUE.sendBatch`. The auth URL,
browser origin and WS ingress must agree. The browser's token
response can override its compiled WS port, so changing only a test URL is
insufficient. The test process also honors `ALOOK_SERVER_URL` and
`DEV_WS_DO_URL`; both must describe this graph's public ingress. A stale
split WS override such as `http://localhost:8789` is rejected. An override does not reconfigure
the launcher's fixed ports. Machines connect through
`/api/ws/community-machine` at the same ingress.

Both Web and Blog are built before startup. Set `ALOOK_E2E_PREBUILT=1` only
after building both from the exact source under test; setup checks that
both Worker entrypoints exist, but does not prove their freshness. This
entry does not provide Next source hot reload: rebuild for source changes.

With the checkout's local state users stopped, local setup moves existing
Web `.wrangler/state` to its sibling `.wrangler/state.e2e-backup` before
either build. This preserves the original bytes, file types and permission
modes, including under a restrictive umask. Startup then resets the test
database and creates fresh actors without replacing that original backup.
Teardown stops the owned process groups before moving the original state
back; build and startup failures use the same cleanup. An unresolved backup
blocks preparation and remains available for recovery; do not delete it
or start another run over it.
Do not set `CI=1` to select the Worker graph: CI also disables the local
state backup. Formal QA probes must use the same managed setup and teardown.

Verify actual shared D1 reads/writes, browser and machine WS events, and
task execution rather than health alone. In this built Worker graph, Web
publishes to the local `alook-queue` binding and the queue worker's `queue()`
consumer runs the existing task handler. Verify send, consumption, D1 state
and the resulting machine wake; health alone is insufficient. This is local
Queue simulation, not proof of production durability or restart recovery.
The separate Next development mode retains its HTTP task transport. Record
the built artifact and transport that actually ran. Worker count, retries,
timeouts and the CI matrix retain their existing settings.

This entry covers UI Playwright and QA using its lifecycle. The separate
Vitest API/integration `pnpm test:e2e` job, root `pnpm dev`, Email topology
and full-stack hot reload retain their existing entrypoints and remain
outside this change.

## Scripts Reference

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start all dev servers (except CLI) |
| `pnpm dev:web` | Next.js on :3000 |
| `pnpm dev:cli` | CLI daemon |
| `pnpm dev:email` | Email worker on :8787 |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run all tests |
| `pnpm db:migrate` | Run D1 migrations locally |
| `pnpm db:reset` | Wipe local D1 and re-migrate |
| `pnpm clean` | Remove node_modules, build artifacts, local D1 |

## Reporting Issues

Use [GitHub Issues](https://github.com/alookai/alook/issues). We have templates for:

- **Bug reports** — reproduction steps, expected vs actual behavior
- **Feature requests** — problem statement, proposed solution

## Community

- [Discord](https://discord.alook.ai) — questions, discussion, help

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
