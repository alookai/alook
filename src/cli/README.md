# @alook/cli

Alook CLI — register machines, run the daemon, and manage agents from the command line.

## Install

```bash
npx @alook/cli <command>
```

## Quick Start

1. Generate a machine token from the [Alook dashboard](https://alook.ai).
2. Register this machine:

```bash
npx @alook/cli register --token al_xxxxxxxxxxxxxxxxxxxxxxxx
```

3. Start the daemon:

```bash
npx @alook/cli daemon start
```

The daemon runs in the background, polling for tasks and dispatching them to your local AI runtimes (Claude, Codex, or OpenCode).

## Commands

| Command | Description |
| --- | --- |
| `register --token <token>` | Register this machine with your Alook account |
| `status` | Show registration status and linked workspace |
| `daemon start` | Start the background daemon |
| `daemon stop` | Stop the daemon |
| `email pull` | Download agent emails |
| `email send --to <addr> --subject "..." --body-file <path>` | Send an email |
| `calendar set --event_title "..." --datetime <YYYY-MM-DDTHH:MM>` | Create a scheduled event |
| `issue create --title "..."` | Create and dispatch an issue |
| `sync upload-artifact --conversation_id <id> --file <path>` | Upload a file artifact |
| `config show` | Show current configuration |
| `update` | Update CLI to the latest version |
| `version` | Print CLI version |

Run `npx @alook/cli <command> --help` for all subcommand options.

<details>
<summary><strong>daemon</strong> — manage the background daemon</summary>

```bash
alook daemon start               # Start in background
alook daemon start --foreground  # Start in foreground (for debugging)
alook daemon stop                # Stop the daemon
alook daemon status              # Check if the daemon is running
```

</details>

<details>
<summary><strong>email</strong> — pull, send, reply, forward, and manage sender whitelist</summary>

```bash
alook email pull                                # Download inbox
alook email pull --status unread                # Unread only
alook email pull --folder sent                  # Sent emails
alook email set --email_id <id> --status read   # Mark as read

alook email send --to <addr> --subject "Hi" --body-file body.html
alook email send ... --in-reply-to <email_id>                   # Reply to a thread
alook email send ... --attachment report.pdf                    # Attach a file
alook email forward --email_id <id> --to <addr> --note "FYI"

alook email whitelist list              # List allowed senders
alook email whitelist add <email>       # Allow a sender
alook email whitelist delete <email>    # Remove a sender
```

Options: `--from <addr>` to send from a custom mailbox, `--limit <n>` / `--offset <n>` for pagination, `--json` for machine-readable output.

</details>

<details>
<summary><strong>calendar</strong> — schedule one-off or recurring agent events</summary>

When an event fires, a new task is dispatched to the agent with the event title as the prompt.

```bash
alook calendar set --event_title "Daily standup" --datetime 2026-05-16T09:00
alook calendar set ... --repeat 1week --repeat_stop_date 2026-12-31

alook calendar list                              # List upcoming events
alook calendar show --event_id <id>              # Show full detail
alook calendar update --event_id <id> --datetime 2026-05-17T10:00
alook calendar delete --event_id <id>
```

Datetime is always local time (`YYYY-MM-DDTHH:MM`). Repeat intervals: `1hour`, `1day`, `1week`, `1month`, etc.

</details>

<details>
<summary><strong>issue</strong> — create and manage issues assigned to agents</summary>

```bash
alook issue create --title "Fix login bug"
alook issue create --title "Refactor auth" --body-file spec.md

alook issue list                           # Active issues
alook issue list --completed               # Completed/closed issues
alook issue show --issue_id <id>           # Full detail + conversation
alook issue update --issue_id <id> --status done
alook issue comment --issue_id <id> --body "Looks good"
```

Statuses: `todo`, `in_progress`, `review`, `done`, `closed`, `canceled`, `failed`.

</details>

<details>
<summary><strong>config</strong> — manage CLI configuration</summary>

```bash
alook config show    # Show current config
alook config path    # Show config file path
```

Config is stored at `~/.alook/config.json` and includes:

- `server_url` — Alook server URL
- `profiles` — per-profile settings with workspace bindings
- `watched_workspaces` — workspaces the daemon monitors (each with `id`, `name`, `token`, `agent_ids`)

</details>

## Global Options

```
--server <url>     Override server URL
--profile <name>   Use a specific config profile
--agent_id <id>    Override agent ID (default: $ALOOK_AGENT_ID env var)
```

## Requirements

- Node.js >= 20

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
