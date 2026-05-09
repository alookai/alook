# Alook

Email-driven autonomous agent platform. Users create AI agents with email handles — when an agent receives an email, a runtime machine executes the task using Claude or Codex and streams results back to the dashboard in real time.

## Architecture

```mermaid
graph TD
    SMTP["Inbound Email (SMTP)"] --> EW

    EW["Email Worker<br/><i>parse, store R2, create event</i>"]
    EW -- "service binding<br/>POST /api/email/notify" --> WS

    Browser["Browser (React)"] <-- "WebSocket<br/>(via WS-DO)" --> WS
    WS["Web Service<br/><i>Next.js on Cloudflare Workers</i>"]
    WS <-- "HTTP polling" --> CLI["CLI Daemon<br/><i>(Bun runtime)</i>"]

    WS -- "service binding" --> DO["WS-DO<br/><i>Browser-only real-time<br/>WebSocket channels</i>"]
```

### Service Relationships

```mermaid
graph TD
    subgraph CF["Cloudflare Edge"]
        subgraph Workers
            EW["Email Worker"]
            WS["Web Service"]
            DO["WS-DO<br/>(Durable Objects)"]
        end
        subgraph Infrastructure
            D1["D1 Database<br/>(alook-app)"]
            R2["R2 Bucket<br/>(alook-emails)"]
        end
        BC["Web Dashboard"]
    end

    subgraph RM["Runtime Machine"]
        CLI["CLI Daemon<br/>- Heartbeat (15s)<br/>- Event poll (3s)<br/>- Task execution<br/>&nbsp; (Claude / Codex)"]
    end

    EW -- "service binding" --> WS
    WS -- "service binding" --> DO

    EW -- "D1 r/w" --> D1
    EW -- "R2 r/w" --> R2
    WS -- "D1 r/w" --> D1
    WS -- "R2 r/w" --> R2
    DO -- "D1 r/w" --> D1

    DO -- "WebSocket" --> BC
    WS -- "REST API (polling)" --> CLI
```

## Services

| Service | Package | Location | Runtime | Purpose |
|---------|---------|----------|---------|---------|
| **Web** | `@alook/web` | `src/web` | Cloudflare Workers (OpenNext) | Dashboard, REST API, auth, database |
| **Email Worker** | `@alook/email-worker` | `src/email-worker` | Cloudflare Worker | Inbound email parsing, storage, event creation |
| **WS-DO** | `@alook/ws-do` | `src/ws-do` | Cloudflare Durable Objects | Real-time WebSocket channels per agent/user |
| **CLI** | `@alook/cli` | `src/cli` | Bun | Runtime daemon, task execution, agent orchestration |
| **Shared** | `@alook/shared` | `src/shared` | Library | Types, constants, validation utilities |

## Tech Stack

- **Frontend:** Next.js, React, Tailwind CSS, Base UI
- **Backend:** Next.js API routes on Cloudflare Workers
- **Auth:** Better Auth
- **Database:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2
- **Real-time:** WebSockets via Durable Objects
- **AI Runtimes:** Claude Code, Codex, Opencode
- **CLI Runtime:** Bun
- **Monorepo:** Turborepo + pnpm workspaces
- **Testing:** Vitest

## Getting Started

```bash
pnpm clean            # remove node_modules, build artifacts, local D1 state
pnpm install          # install dependencies
pnpm db:migrate       # set up local D1 database
pnpm dev              # start web + workers (excludes CLI)
```

## Development

```bash
pnpm install          # install dependencies
pnpm dev              # start web + workers (excludes CLI)
pnpm dev:cli          # start CLI separately (requires Bun)
pnpm db:migrate       # run D1 migrations locally
pnpm db:reset         # wipe local D1 and re-migrate
pnpm test             # run all tests
pnpm typecheck        # typecheck all packages
```

Local browser entry is `http://127.0.0.1:3003`; keep `src/web/.dev.vars` `BETTER_AUTH_URL` exactly the same.
Use `pnpm dev` for daily development; `@alook/web` listens on `127.0.0.1:3003`.

### Individual services

```bash
pnpm dev:web          # Next.js dev server on :3000
pnpm dev:email        # Email worker on :8788
pnpm dev:cli          # CLI daemon (Bun)
pnpm dev:send <from> <to> [subject] [body]   # simulate inbound email
```

## Key Workflows

**Email reception:** SMTP -> Email Worker -> parse & store in R2/D1 -> create event -> notify web service -> web service broadcasts via WS-DO to browser -> CLI picks up event via HTTP polling

**Task execution:** CLI receives event -> creates task record -> runs Claude/Codex agent with prompt -> streams output chunks to API -> marks complete -> dashboard updates in real time

**Runtime registration:** CLI `register <token>` -> detects local runtimes (claude, codex) -> registers with Web API -> starts daemon (polling)
