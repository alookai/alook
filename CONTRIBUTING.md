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

Alook is a monorepo with five packages:

| Package | Location | What it does |
|---------|----------|-------------|
| `@alook/web` | `src/web` | Next.js dashboard, REST API, auth, database |
| `@alook/cli` | `src/cli` | Runtime daemon, task execution, agent orchestration |
| `@alook/shared` | `src/shared` | Types, constants, DB schema, validation |
| `@alook/email-worker` | `src/email-worker` | Inbound email parsing and storage |
| `@alook/ws-do` | `src/ws-do` | Real-time WebSocket channels |

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

## Scripts Reference

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start all dev servers (except CLI) |
| `pnpm dev:web` | Next.js on :3000 |
| `pnpm dev:cli` | CLI daemon |
| `pnpm dev:email` | Email worker on :8788 |
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
