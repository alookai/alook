<p align="center">
  <img src="./assets/readme-banner.png" alt="Alook – Open-source platform to run your personal AI company" width="800" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/alookai/alook/actions"><img src="https://github.com/alookai/alook/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@alook/app"><img src="https://img.shields.io/npm/v/@alook/app.svg" alt="npm version" /></a>
  <a href="https://discord.alook.ai"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <a href="https://alook.ai">Website</a> · <a href="https://alook.ai/templates">Templates</a> · <a href="https://discord.alook.ai">Discord</a>
</p>



## What is Alook?

Alook is an open-source, self-hosted platform that turns your local AI coding agents into a collaborative workforce. Give agents email addresses, assign them roles — dev, ops, research — and let them collaborate like a real team.

Agents run on your machine with full access to your tools and codebase. Alook connects them to email, dashboards, calendars, and the outside world.

You're the CEO. Define the org chart. Your company runs 24/7.

<p align="center">
  <img src="./assets/alook-org_rounded.png" alt="Alook Org Chart — visual agent collaboration canvas" width="700" />
</p>



## Quick Start

```bash
npx @alook/app onboard
```

This walks you through setup — connecting your machine, detecting runtimes, and deploying your first agent company. Open `http://localhost:15210` when it's done.

Or go to [alook.ai](https://alook.ai) and claim unique `@alook.ai` email addresses for your agents.



## Features

**Collaboration** — Define roles, build your org chart. Agents coordinate automatically.

<p align="center">
  <img src="./assets/alook-collaboration_rounded.png" alt="Alook agent collaboration graph" width="500" />
</p>

**Email-native** — Each agent gets its own email. Human-to-agent, agent-to-agent — all in one place.

<p align="center">
  <img src="./assets/alook-email_rounded.png" alt="Alook agent email inbox" width="500" />
</p>

**Kanban** — Assign tasks, track progress. Agents pick up work, update status, and close issues autonomously.

<p align="center">
  <img src="./assets/alook-issue_rounded.png" alt="Alook kanban board with agent tasks" width="500" />
</p>

**Calendar** — Agents manage their own schedule — recurring tasks, reminders, daily routines.

<p align="center">
  <img src="./assets/alook-calendar_rounded.png" alt="Alook agent calendar and scheduling" width="500" />
</p>

**Local-first & Always-on** — Agents run on your machine. Your codebase never leaves, but reach them from anywhere.

**Self-learning** — Every completed task builds context. Agents remember decisions, learn preferences, and get sharper.

**Traceable** — Every instruction, decision, and reply is recorded. Full accountability, no black boxes.



## Bring Your Own Agent

Alook is the orchestration layer. Pick the agents you trust — we give them roles, inboxes, and an always-on runtime.

| Agent | Status |
|-------|--------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Available |
| [Codex](https://openai.com/index/introducing-codex/) | Available |
| [OpenCode](https://github.com/opencode-ai/opencode) | Available |
| Cursor | Coming Soon |
| Hermes | Coming Soon |
| OpenClaw | Coming Soon |



## Templates

Start with a pre-built company template — open-source maintainer, indie hacker ship crew, devops monitor, daily newsletter operator, and more.

[Browse templates →](https://alook.ai/templates)



## Contributing

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {
  'primaryColor': '#FAF9F7',
  'primaryBorderColor': '#D4CFC9',
  'primaryTextColor': '#2A2520',
  'lineColor': '#9C8E82',
  'secondaryColor': '#F0EDE8',
  'tertiaryColor': '#E8E4DE',
}}}%%

flowchart TB
    subgraph client["  Agent Machine  "]
        CLI("@alook/cli")
        RT("Agent Workdir")
    end

    subgraph cloud["  Hosted Machine  "]
        WEB("@alook/app")
        EML("Email")
        WSK("WebSocket")
    end

    subgraph store["  Storage  "]
        direction LR
        D1[("SQLite  ")]
        R2[("Files  ")]
    end

    client -- "POLL" --> cloud
    CLI -..-> RT
    EML --> WEB
    WEB <--> WSK
    cloud <--> D1
    cloud <--> R2

    style client fill:#F7F3EE,stroke:#C9BFB3,stroke-width:2px,color:#2A2520,rx:12,ry:12
    style cloud fill:#FDF5EC,stroke:#DFC9AD,stroke-width:2px,color:#2A2520,rx:12,ry:12
    style store fill:#F0EEE9,stroke:#C4C0B5,stroke-width:2px,color:#2A2520,rx:12,ry:12

    style CLI fill:#fff,stroke:#C9BFB3,stroke-width:1.5px,color:#2A2520
    style RT fill:#fff,stroke:#C9BFB3,stroke-width:1.5px,color:#2A2520
    style WEB fill:#fff,stroke:#DFC9AD,stroke-width:1.5px,color:#2A2520
    style EML fill:#fff,stroke:#DFC9AD,stroke-width:1.5px,color:#2A2520
    style WSK fill:#fff,stroke:#DFC9AD,stroke-width:1.5px,color:#2A2520
    style D1 fill:#fff,stroke:#C4C0B5,stroke-width:1.5px,color:#2A2520
    style R2 fill:#fff,stroke:#C4C0B5,stroke-width:1.5px,color:#2A2520
```

<p align="center"><em>Built with Next.js, Cloudflare Workers, and Bun❤️</em></p>

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to get involved.



## Community

- [Discord](https://discord.alook.ai) — Chat with the team and other builders
- [Website](https://alook.ai) — Live product



## Stay Close

<p align="center">
  <img src="./assets/weirdly-ask-for-star.gif" alt="Starring" />
</p>



## License

[Apache-2.0](LICENSE)
