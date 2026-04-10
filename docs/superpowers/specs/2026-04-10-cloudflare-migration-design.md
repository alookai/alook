# Cloudflare Edge Migration — Design Spec

> Migrate Alook from Node.js + PostgreSQL to Cloudflare Workers + D1 + R2 + Durable Objects.
> Scope: Phases 0–3 (backend + frontend). Phase 4 (integration/deployment) deferred.

---

## Sources

- `docs/migration/00-06` — migration specs (the authority)
- `temp/main/` — current production codebase (Node.js + PostgreSQL, 227 files)
- `temp/spec-plans/` — Cloudflare edge reference implementation (167 files)

## Strategy

**Hybrid: copy unchanged, rewrite divergent.**

Files from spec-plans that match the migration docs are copied as-is (configs, utils, wrangler files). Files where the docs diverge from spec-plans are rewritten (shared DB layer, email worker, web service API routes).

## Scope

| Phase | Description | Strategy |
|-------|-------------|----------|
| 0 | Monorepo scaffold, Turborepo, wrangler configs | Copy from spec-plans |
| 1 | `@alook/shared` — schema, DB factory, queries, types, constants, schemas, utils | Rewrite: merge main's rich types/schemas with spec-plans' utils; new Drizzle D1 schema + query modules migrated from main |
| 2a | Web Service — D1 + Better Auth + OpenNext + API routes + middleware + services | Hybrid: copy auth/config from spec-plans, rewrite API routes from main for D1 |
| 2b | Email Worker — Cloudflare Worker for inbound email | Rewrite: Drizzle via shared, read-only D1, notify web service for writes |
| 2c | WS-DO — Durable Objects for browser notifications | Copy + adapt: update token validation to session-only via shared queries |
| 3 | Frontend — pages, components, contexts, CSS, client hooks | Copy from main, adapt auth (JWT->Better Auth), add WS hooks from spec-plans |

**Out of scope:** Phase 4 (integration/CLI/deployment).

## Key Divergences (spec-plans vs migration docs)

These require rewriting rather than copying:

1. **Shared DB layer** — spec-plans has no `db/` in shared. Docs move all Drizzle schema + query modules into `@alook/shared/db/`.
2. **Email Worker** — spec-plans uses raw D1 + writes emails/events directly. Docs: Drizzle via shared, read-only D1, POST `/api/email/notify` to web service for writes.
3. **WS-DO token validation** — spec-plans validates both runtime tokens and session tokens. Docs: session tokens only (browser-only WebSocket).
4. **Web Service queries** — main has 11+ query modules in `src/web/lib/db/queries/`. These move to `@alook/shared/db/queries/` and convert from `pgTable` to `sqliteTable`.
5. **Types/Constants** — main's shared has rich types + Zod schemas + API types. Spec-plans has simpler types. Docs follow main's model, extended with email/whitelist types.

---

## Phase 0 — Infrastructure Setup

Copy from spec-plans with minor adjustments:

| File | Source | Notes |
|------|--------|-------|
| `package.json` | spec-plans | Add `cli` script from docs |
| `pnpm-workspace.yaml` | spec-plans | As-is |
| `turbo.json` | spec-plans | As-is |
| `vitest.config.ts` | spec-plans | As-is |
| `vitest.shared.ts` | spec-plans | As-is |
| `.gitignore` | New | Combine spec-plans + main patterns |
| `src/shared/` scaffold | spec-plans package.json + tsconfig + vitest config | Content populated in Phase 1 |
| `src/cli/` scaffold | spec-plans package.json + tsconfig | Stub index.ts |
| `src/web/` scaffold | spec-plans package.json + tsconfig + next.config + open-next + wrangler + postcss + components.json | Web config files from spec-plans |
| `src/email-worker/` scaffold | spec-plans package.json + tsconfig + vitest + wrangler | Stub index.ts |
| `src/ws-do/` scaffold | spec-plans package.json + tsconfig + wrangler | Stub index.ts |

Exit: `pnpm install` succeeds. All packages resolve.

---

## Phase 1 — Shared Library (`@alook/shared`)

The foundation. All other phases depend on this.

### Module structure

```
src/shared/
  src/
    index.ts           — re-exports everything
    types.ts           — from main (User, Workspace, Agent, etc.)
    api-types.ts       — from main (ApiResponse, typed responses)
    constants.ts       — from main (AgentStatus, RuntimeStatus, TaskStatus, MessageRole)
    schemas.ts         — from main (Zod validation schemas for daemon API)
    db/
      index.ts         — createDb(d1Binding) factory (NEW)
      schema.ts        — Drizzle sqliteTable definitions (REWRITE from main's pgTable)
      queries/         — 12 query modules (MIGRATE from main's src/web/lib/db/queries/)
        user.ts
        workspace.ts
        member.ts
        agent.ts
        runtime.ts
        conversation.ts
        message.ts
        task.ts
        task-message.ts
        machine-token.ts
        whitelist.ts     (NEW)
        email.ts         (NEW)
        session.ts       (NEW)
    utils/
      email.ts         — from spec-plans (parseEmailHandle, toAlookAddress, isValidHandle)
      validation.ts    — from spec-plans (isValidToken, isValidEmail)
      status.ts        — from spec-plans (isOnline, formatStatus)
  test/                — from spec-plans (constants, utils tests)
  package.json         — add drizzle-orm dependency (spec-plans version has no drizzle)
```

### Schema migration (pgTable to sqliteTable)

Key type changes from main's PostgreSQL schema:
- `uuid` PK with `defaultRandom()` -> `text` PK with nanoid
- `timestamp` -> `text` with `DEFAULT (datetime('now'))`
- `boolean` -> `integer` (0/1)
- `jsonb` -> `text` (serialized JSON)
- `pgTable` -> `sqliteTable`
- Task claiming: `FOR UPDATE SKIP LOCKED` -> CAS-style `UPDATE ... WHERE status='queued'`

### Tables (15 total)

Better Auth managed (4): `user`, `session`, `account`, `verification`
Application (11): `workspace`, `member`, `agent_runtime`, `agent`, `agent_whitelist`, `conversation`, `message`, `agent_task_queue`, `task_message`, `emails`, `machine_token`

### Query module migration

Each query module from `temp/main/src/web/lib/db/queries/*.ts` gets:
1. Converted from PostgreSQL Drizzle to D1 Drizzle (sqliteTable references)
2. Moved to `src/shared/db/queries/`
3. Functions accept `db: Database` as first parameter (instead of importing global `db`)

Exit: `@alook/shared` builds. Exports `createDb`, `schema`, `queries`, all types/schemas/constants/utils.

---

## Phase 2a — Web Service

### Copy from spec-plans (unchanged)
- `wrangler.toml`, `next.config.ts`, `open-next.config.ts`, `cloudflare-env.d.ts`
- `src/env.d.ts`, `postcss.config.mjs`, `components.json`
- `src/lib/auth.ts`, `src/lib/auth-client.ts` (Better Auth setup)
- `src/lib/session.ts` (server-side session helper)
- `src/lib/broadcast.ts` (WS-DO notification helper)
- `src/lib/storage.ts` (R2 email storage)
- `src/lib/utils.ts` (cn utility)
- `src/middleware.ts` (auth guard for dashboard routes)
- `src/app/api/auth/[...all]/route.ts` (Better Auth catch-all)

### Rewrite (adapted from main for D1)
- `src/lib/dual-auth.ts` — use shared queries instead of raw D1
- `src/lib/api/responses.ts` — from main (snake_case formatters)
- `src/lib/middleware/*` — from main (workspace, request-id, logger, helpers)
- `src/lib/services/task.ts` — from main, adapted for shared queries
- `src/lib/errors.ts`, `src/lib/logger.ts` — from main
- `src/lib/api.ts` — from main (client-side API wrapper, update auth for Better Auth)
- All 37 API routes — from main, switch from local db import to shared queries
- `src/app/api/email/notify/route.ts` — new endpoint per migration docs
- `src/app/api/ws/token/route.ts` — from spec-plans
- D1 migration SQL file (`migrations/0001_schema.sql`)
- `drizzle.config.ts` pointing to `@alook/shared` schema

Exit: Web service compiles. API routes resolve against shared imports. D1 migration applies.

---

## Phase 2b — Email Worker

**Full rewrite** per migration docs. Spec-plans code used as structural reference only.

Changes from spec-plans:
- Import `createDb`, `queries` from `@alook/shared` (Drizzle, not raw D1)
- Read-only D1: agent lookup + whitelist check via shared queries
- No direct email/event writes — POST `/api/email/notify` to web service
- Web service handles: email record creation, task creation, WS-DO broadcast

Files:
- `src/index.ts` — email handler + /simulate endpoint
- `src/index.test.ts` — adapted tests (mock Drizzle DB, verify notify payload)
- `src/__mocks__/cf.ts` — updated mocks

Exit: Email worker compiles, tests pass.

---

## Phase 2c — WS-DO

**Copy + adapt** from spec-plans. Minimal changes.

Changes from spec-plans:
- Token validation: session tokens only (remove runtime token validation)
- Use `queries.session.getValidSession` from `@alook/shared` instead of raw D1
- Remove agent channel broadcasts (user channels only per docs)
- Simplify index.ts routing (remove `/broadcast/:agentId` — only `/broadcast/user/:userId`)

Files:
- `src/index.ts` — worker entry (simplified routing)
- `src/ws-durable.ts` — Durable Object (session-only auth)
- `src/env.d.ts`

Exit: WS-DO compiles.

---

## Phase 3 — Frontend (Pages + Components)

**Copy from main**, adapt auth references (JWT -> Better Auth), add WebSocket hooks from spec-plans.

### Copy from main (adapt imports)

**Layouts:**
- `app/layout.tsx` — root layout (fonts, ThemeProvider, ToasterProvider)
- `app/(app)/layout.tsx` — app shell (auth guard, sidebar, AgentProvider)

**Pages:**
- `app/page.tsx` — root redirect (session check -> `/home` or `/sign-in`)
- `app/(app)/home/page.tsx` — redirect to first agent
- `app/(app)/agents/page.tsx` — redirect to `/home`
- `app/(app)/agents/[id]/page.tsx` — agent detail
- `app/(app)/agents/new/page.tsx` — create agent form
- `app/(app)/chat/[id]/page.tsx` — chat UI
- `app/(app)/runtimes/page.tsx` — machine/runtime list

**Auth pages (rewrite for Better Auth):**
- `app/(auth)/sign-in/page.tsx` — email/password + OAuth (replaces main's `app/login/page.tsx` OTP flow)
- `app/(auth)/sign-up/page.tsx` — registration (new, Better Auth)

**Components (copy as-is):**
- `components/app-sidebar.tsx` — narrow sidebar with agent list (update signOut to Better Auth)
- `components/agent-edit-form.tsx` — agent create/edit form
- `components/runtime-select.tsx` — runtime picker
- `components/dashboard-navbar.tsx`, `components/gradient-background.tsx`, `components/logo.tsx`
- `components/theme-provider.tsx`, `components/theme-toggle.tsx`, `components/toaster-provider.tsx`
- `components/ui/*` — all UI primitives (button, input, textarea, label, badge, card, dialog, confirm-dialog, select, sheet, scroll-area, separator, avatar)
- Remove `components/ui/input-otp.tsx` (OTP no longer needed)

**Context:**
- `contexts/agent-context.tsx` — global agent/runtime state (update API calls for new auth)

**CSS:**
- `app/globals.css`

### Add from spec-plans (new)
- `src/lib/use-ws.ts` — agent WebSocket hook
- `src/lib/use-user-ws.ts` — user WebSocket hook
- `src/hooks/use-mobile.ts` — if exists in spec-plans

### Adaptation notes

| Main pattern | Target change |
|-------------|---------------|
| `import { verifyJWT } from "@/lib/auth/jwt"` | Remove — server pages use `getSession()` from `@/lib/session` |
| localStorage JWT token | Better Auth session cookie (automatic) |
| `apiFetch` with Bearer JWT header | `apiFetch` with cookie auth (remove Authorization header for browser) |
| `useSession` (custom) | `useSession` from `better-auth/react` via `@/lib/auth-client` |
| `signOut` (clear localStorage) | `signOut` from `better-auth/react` |
| `/login` route | `/sign-in` and `/sign-up` routes |
| No WebSocket | Add `useUserWs` hook for real-time notifications |

Exit: Frontend pages render. Auth flow works with Better Auth. WebSocket hooks available.

---

## Execution Plan

```
Phase 0 ──── single agent, fast scaffold
Phase 1 ──── single agent, careful migration of schema + queries
Phase 2a ─┐
Phase 2b ─┼─ 3 parallel subagents
Phase 2c ─┘
Phase 3 ──── single agent (depends on 2a + 2c)
```

Commits at natural stopping points. No strict granularity.
