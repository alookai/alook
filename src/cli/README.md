# @alook/cli

Alook CLI — register and run always-on AI coding agents.

## Install

```bash
npx @alook/cli <command>
```

Or install globally:

```bash
npm install -g @alook/cli
alook <command>
```

## Quick start

Register this machine with your Alook account:

```bash
npx @alook/cli register --token al_xxxxxxxxxxxxxxxxxxxxxxxx
```

You can generate a token from the Alook dashboard.

## Commands

| Command | Description |
| --- | --- |
| `alook register` | Register this machine with your Alook account. |
| `alook status` | Show current registration status. |
| `alook daemon` | Manage the local Alook daemon. |
| `alook email` | Manage agent emails. |
| `alook config` | Manage CLI configuration. |
| `alook version` | Print the CLI version. |

Run `alook <command> --help` for subcommand options.

## Requirements

- Node.js ≥ 20

## License

Apache-2.0 — see [LICENSE](./LICENSE).
