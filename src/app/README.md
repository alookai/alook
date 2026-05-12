# @alook/app

Run Alook locally — one command, no clone needed.

## Quick Start

```bash
npx @alook/app onboard
```

This will:
1. Install Alook to `~/.alook/self-hosted/`
2. Initialize the database
3. Start all services (web, email worker, WebSocket)
4. Guide you through account creation
5. Register your AI runtime (Claude, Codex, or OpenCode)
6. Open the dashboard in your browser

## Commands

| Command | Description |
| --- | --- |
| `npx @alook/app onboard` | Full setup and start |
| `npx @alook/app start` | Start existing installation |
| `npx @alook/app stop` | Stop all services |
| `npx @alook/app update` | Update to latest version |

## Options

```
--port-web <port>    Web server port (default: 3000)
--port-email <port>  Email worker port (default: 8787)
--port-ws <port>     WebSocket worker port (default: 8789)
--skip-register      Skip account creation
```

## Requirements

- Node.js >= 20
- One of: `claude`, `codex`, or `opencode` CLI installed

## Limitations

- Email send/receive is not available in local mode
- OAuth login (GitHub, Google) is disabled; use email/password

## License

Apache-2.0
