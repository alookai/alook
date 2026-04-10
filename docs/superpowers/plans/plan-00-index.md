# Cloudflare Edge Migration — Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Migrate Alook from Node.js + PostgreSQL to Cloudflare Workers + D1 + R2 + Durable Objects.

**Architecture:** 5-service monorepo (web, cli, email-worker, ws-do, shared) on pnpm + Turborepo. D1 via Drizzle ORM. Better Auth replaces custom JWT. OpenNext deploys Next.js to Workers.

**Tech Stack:** Cloudflare Workers, D1, R2, Durable Objects, Next.js, OpenNext, Drizzle ORM, Better Auth, Turborepo, pnpm, Vitest

**Spec:** `docs/superpowers/specs/2026-04-10-cloudflare-migration-design.md`

---

## Plan Files

| File | Phase | Dependencies | Parallelizable |
|------|-------|-------------|----------------|
| [plan-01-phase0-infra.md](plan-01-phase0-infra.md) | 0 — Infrastructure | None | No |
| [plan-02-phase1-shared.md](plan-02-phase1-shared.md) | 1 — Shared Library | Phase 0 | No |
| [plan-03-phase2a-web.md](plan-03-phase2a-web.md) | 2a — Web Service | Phase 1 | Yes (with 2b, 2c) |
| [plan-04-phase2b-email.md](plan-04-phase2b-email.md) | 2b — Email Worker | Phase 1 | Yes (with 2a, 2c) |
| [plan-05-phase2c-wsdo.md](plan-05-phase2c-wsdo.md) | 2c — WS-DO | Phase 1 | Yes (with 2a, 2b) |
| [plan-06-phase3-frontend.md](plan-06-phase3-frontend.md) | 3 — Frontend | Phase 2a | No |

## Execution Order

```
Phase 0 ──── single agent
Phase 1 ──── single agent
Phase 2a ─┐
Phase 2b ─┼─ 3 parallel subagents
Phase 2c ─┘
Phase 3 ──── single agent
```

## Reference Material

- `temp/main/` — current production codebase (origin/main)
- `temp/spec-plans/` — Cloudflare edge reference (origin/chore/spec-plans)

## Strategy

**Hybrid: copy unchanged files from spec-plans, rewrite where migration docs diverge.**

Key divergences requiring rewrites:
1. Shared DB layer (new — schema + queries move into @alook/shared)
2. Email Worker (Drizzle via shared, read-only D1, notify web service)
3. WS-DO (session-only token validation, user channels only)
4. Web API routes (main's routes adapted for D1/shared imports)
5. Types/Constants (main's rich model, not spec-plans' simpler types)
