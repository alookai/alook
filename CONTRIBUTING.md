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
