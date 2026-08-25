# @alook/app

Run Alook locally — one command, no clone needed.

## Quick Start

```bash
npx @alook/app onboard
```

This will:

1. Check your environment (Node.js >= 20, AI runtime)
2. Install Alook to `~/.alook/self-hosted/`
3. Generate secrets (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`)
4. Run database migrations (SQLite via Cloudflare D1 local)
5. Start all services (web, email worker, WebSocket, wake worker)
6. Create your local account
7. Pair this machine and start `@alook/daemon`
8. Open the dashboard in your browser

## Commands

| Command | Description |
| --- | --- |
| `npx @alook/app onboard` | Full setup: install, migrate, start, and pair |
| `npx @alook/app start` | Start services from an existing installation |
| `npx @alook/app stop` | Stop all services |
| `npx @alook/app update` | Update services and re-run migrations |

### Embedded daemon

`@alook/app` bundles the current `@alook/daemon` CLI. Pairing happens automatically during onboard; saved machine credentials remain private in the app-owned data directory.

```bash
npx @alook/app daemon list                   # List paired/running daemons
npx @alook/app daemon status [machine-id]    # Check agent status
npx @alook/app daemon stop <machine-id>      # Stop one daemon
npx @alook/app daemon start --id <machine-id> # Restart without exposing its credential
```

## Options

```
--port-web <port>    Web server port (default: 15210)
--port-email <port>  Email worker port (default: 15211)
--port-ws <port>     WebSocket worker port (default: 15212)
--port-wake <port>   Wake worker port (default: 15213)
--skip-register      Skip account creation (onboard only)
```

## Architecture

### Services

Alook runs four local services, each in its own Wrangler dev process:

| Service | Default Port | Description |
| --- | --- | --- |
| **Web** | 15210 | Main web app (Next.js on Wrangler) — dashboard, API, auth |
| **Email Worker** | 15211 | Email processing worker |
| **WebSocket (WS-DO)** | 15212 | Real-time communication via Durable Objects |
| **Wake Worker** | 15213 | Dispatches unread-message wake events to local daemons |

All services share a single SQLite database (Cloudflare D1 local mode) with state persisted at `~/.alook/self-hosted/web/.wrangler/state/`.

### Directory Layout

```
~/.alook/self-hosted/
├── web/                  # Web app (wrangler.toml, migrations, .dev.vars)
│   ├── .wrangler/state/  # D1 database & KV persistence
│   └── migrations/       # SQL migration files
├── email-worker/         # Email worker (wrangler.toml, .dev.vars)
├── ws-do/                # WebSocket Durable Object worker
├── wake-worker/          # Agent wake dispatcher
├── daemon/               # Private machine credentials, daemon state, and logs
├── logs/                 # Service logs (web, email, WS, and wake workers)
└── .pids.json            # PID tracking for running services
```

### Database Migrations

Migrations are SQL files applied via `wrangler d1 migrations apply --local`. They run automatically during:

- **`onboard`** — applies all migrations on fresh install
- **`update`** — applies any new migrations after installing the latest version

Wrangler tracks which migrations have been applied; only pending ones are executed.

### Secrets Management

On first `onboard`, secrets are auto-generated and written to `.dev.vars` files:

- **Web**: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ENCRYPTION_KEY`, OAuth client ID/secret placeholders
- **Email Worker**: `ENCRYPTION_KEY` (synced from web)

Secrets are never overwritten on subsequent runs — only missing files are created.

## Dev Mode

When the `ALOOK_PROJECT_ROOT` environment variable is set, `@alook/app` runs in dev mode against the monorepo:

- Runs `pnpm predev` to set up environment files
- Runs `pnpm db:migrate` for migrations (instead of Wrangler CLI)
- Starts web via `next dev` (instead of Wrangler)
- Services run in foreground with prefixed log output (`[web]`, `[email-worker]`, `[ws-do]`)
- `Ctrl+C` cleanly stops all services

```bash
ALOOK_PROJECT_ROOT=/path/to/alook npx @alook/app onboard
```

## Requirements

- Node.js >= 20.9
- A supported agent runtime such as Claude Code, Codex, OpenCode, Pi, or Cursor

## Limitations

- Email send/receive is not available in local mode
- OAuth login (GitHub, Google) is disabled; use email/password

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
