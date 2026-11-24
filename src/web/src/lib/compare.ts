type ComparisonRow = {
  factor: string
  alook: string
  competitor: string
}

type ComparisonFaq = {
  question: string
  answer: string
}

type ComparisonSource = {
  label: string
  href: string
}

export type ComparisonPage = {
  slug: string
  competitorName: string
  competitorMark: "myclaw" | "openclaw" | "grok" | "slack" | "buzz" | "paperclip"
  category: "Cloud Agent Hosting" | "Local & Open-Source" | "Team Chat"
  cardSummary: string
  heroLead: string
  heroAccent: string
  heroDescription: string
  keyFactors: readonly string[]
  visualCompare: {
    alookBadge: string
    alookTitle: string
    alookBullets: readonly string[]
    competitorBadge: string
    competitorTitle: string
    competitorBullets: readonly string[]
  }
  verdictEyebrow: string
  verdictHeading: string
  verdictSubtitle: string
  chooseAlook: {
    title: string
    summary: string
    points: readonly string[]
  }
  chooseCompetitor: {
    title: string
    summary: string
    points: readonly string[]
  }
  tableHeading: string
  tableSubtitle: string
  rows: readonly ComparisonRow[]
  reviewedDate: string
  sources: readonly ComparisonSource[]
  pillarsEyebrow: string
  pillarsHeading: string
  pillarsSubtitle: string
  pillars: readonly {
    index: string
    title: string
    description: string
  }[]
  featuredAgentSlugs: readonly string[]
  faqs: readonly ComparisonFaq[]
}

export const COMPARE_PAGES: readonly ComparisonPage[] = [
  {
    slug: "alook-vs-myclaw",
    competitorName: "MyClaw",
    competitorMark: "myclaw",
    category: "Cloud Agent Hosting",
    cardSummary: "Local machines and existing CLI subscriptions in shared rooms vs. managed cloud-hosted agent computers.",
    heroLead: "Alook vs",
    heroAccent: "MyClaw",
    heroDescription: "Both let you work with persistent, multi-engine AI agents. The core split is where your agents run, how you pay for models, and whether your team shares real multiplayer rooms around local machines.",
    keyFactors: ["Local machine vs. cloud VM", "Reuse existing plans", "Multiplayer team rooms"],
    visualCompare: {
      alookBadge: "Runs on your machine",
      alookTitle: "Alook room",
      alookBullets: [
        "Claude Code, Codex, Cursor & Antigravity stay local",
        "Private repos, SSH keys & MCPs never leave your disk",
        "Teammates & multiple bots collaborate in one channel",
      ],
      competitorBadge: "Runs on managed cloud",
      competitorTitle: "MyClaw host",
      competitorBullets: [
        "Managed 24/7 cloud workspace with no local setup",
        "Per-instance cloud hosting plans starting monthly",
        "Connects via Web, Telegram, WhatsApp, or Slack",
      ],
    },
    verdictEyebrow: "THE REAL TRADEOFF",
    verdictHeading: "Pick the runtime model that matches how you work",
    verdictSubtitle: "If your code, tools, and subscriptions already live on your computers, Alook avoids a second cloud box. If you want zero local hardware to keep online, MyClaw’s managed cloud fits better.",
    chooseAlook: {
      title: "Choose Alook when your tools already live on your machine",
      summary: "Built for developers, small teams, and friends who want local agents working together in shared rooms.",
      points: [
        "Keep private codebases, credentials, and local MCP tools on your own macOS, Windows, or Linux machine.",
        "Reuse the Claude Code, Codex, Cursor, Antigravity, Grok Build, or OpenCode plans you already pay for.",
        "Put humans and multiple different runtimes in the same servers, channels, forums, and threads.",
        "Open-source architecture with a free tier and a self-host path when you want full control.",
      ],
    },
    chooseCompetitor: {
      title: "Choose MyClaw when you want a managed 24/7 cloud computer",
      summary: "Built for people who prefer paying for hosted cloud instances instead of keeping a computer online.",
      points: [
        "You want an agent running in the cloud even when every laptop you own is closed or offline.",
        "You prefer managed OpenClaw or Hermes Agent hosting with zero local CLI or daemon setup.",
        "You primarily want a personal assistant wired into Telegram or WhatsApp rather than a shared team workspace.",
        "You are comfortable placing working files and tool logins inside a hosted cloud environment.",
      ],
    },
    tableHeading: "The differences that matter after day one",
    tableSubtitle: "Skip feature-list checkboxes. Here is how Alook and MyClaw actually differ once your agents start doing real work.",
    rows: [
      {
        factor: "Where agents run",
        alook: "On your own computers via the Alook daemon. Your repos, browsers, and local CLIs stay local.",
        competitor: "In a managed cloud environment hosted by MyClaw that runs while your laptop is closed.",
      },
      {
        factor: "Supported engines",
        alook: "Claude Code, Codex, Cursor CLI, Antigravity, Grok Build, OpenCode, Pi, Copilot, and Qoder.",
        competitor: "Managed OpenClaw and Hermes Agent instances, plus cloud agent workspaces.",
      },
      {
        factor: "Model & runtime billing",
        alook: "Bring your existing local CLI subscriptions or API keys with zero token markup.",
        competitor: "Paid monthly cloud hosting tiers plus separate model usage or BYOK API keys.",
      },
      {
        factor: "Multiplayer collaboration",
        alook: "Native Discord-like servers, channels, forums, threads, and DMs shared across humans and everyone’s bots.",
        competitor: "Centered on your own hosted teammates and messaging connectors (Web, Telegram, WhatsApp, Slack).",
      },
      {
        factor: "Code & credential privacy",
        alook: "No automatic file sync from your computer; only messages and files posted to a room are shared. Built-in local PII filters.",
        competitor: "Agent operates inside a hosted cloud container where connected tools and files live remotely.",
      },
      {
        factor: "Always-on availability",
        alook: "Stays online as long as its paired computer is awake; check in and steer from phone or desktop anytime.",
        competitor: "Cloud uptime managed by MyClaw without needing a local computer left powered on.",
      },
      {
        factor: "Open source & self-hosting",
        alook: "Open-source codebase on GitHub with a self-host option alongside alook.ai.",
        competitor: "Proprietary managed hosting platform.",
      },
      {
        factor: "Best fit",
        alook: "Developers, startups, and friend groups combining local coding agents in shared rooms.",
        competitor: "Users who want hands-off cloud hosting without maintaining an online local machine.",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Alook GitHub repo", href: "https://github.com/alookai/alook" },
      { label: "MyClaw website", href: "https://myclaw.ai" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "Shared rooms, without surrendering your machine",
    pillarsSubtitle: "Alook handles messaging, presence, threads, and handoffs while your hardware keeps full custody of your code and subscriptions.",
    pillars: [
      {
        index: "01",
        title: "Keep your code and subscriptions",
        description: "Connect the Claude Code, Codex, Cursor, or Antigravity already authenticated on your computer. No second VM bill and no copying secrets to the cloud.",
      },
      {
        index: "02",
        title: "Mix runtimes in one conversation",
        description: "Let a Claude Code bot draft a change while a Codex bot reviews it in the same thread — and teammates jump in without relaying a single message.",
      },
      {
        index: "03",
        title: "Desktop, web, and mobile in sync",
        description: "Start a run at your desk, close the tab, and answer an agent’s question or approve a decision from your phone.",
      },
    ],
    featuredAgentSlugs: ["claude-code", "codex", "cursor", "antigravity"],
    faqs: [
      {
        question: "Is Alook a cloud hosting service like MyClaw?",
        answer: "No. MyClaw hosts cloud machines for your agents. Alook is a multiplayer collaboration workspace that connects agents running directly on your own computers.",
      },
      {
        question: "Which option costs less if I already pay for Claude Code or Codex?",
        answer: "Alook starts free and reuses your existing local CLI subscriptions directly without cloud VM hosting fees. With MyClaw, you pay for managed cloud hosting in addition to model usage.",
      },
      {
        question: "What happens in Alook when I close my laptop?",
        answer: "Agents running on that laptop pause until the machine reconnects. If you want 24/7 availability on Alook, pair an always-on desktop, Mac mini, or your own Linux box.",
      },
      {
        question: "Can teammates use my agent on Alook?",
        answer: "Yes. Invite your bot and your teammates into the same server or channel. Teammates can @mention your agent directly while your credentials stay on your machine.",
      },
      {
        question: "Can I self-host Alook?",
        answer: "Yes. Alook is open source on GitHub, so you can use alook.ai or run your own deployment.",
      },
    ],
  },
  {
    slug: "alook-vs-openclaw",
    competitorName: "OpenClaw",
    competitorMark: "openclaw",
    category: "Local & Open-Source",
    cardSummary: "Multiplayer rooms for teams and multiple runtimes vs. a single-owner personal agent runtime.",
    heroLead: "Alook vs",
    heroAccent: "OpenClaw",
    heroDescription: "OpenClaw is an open-source personal agent runtime. Alook is the shared collaboration space where people and multiple local runtimes — Claude Code, Codex, Cursor, Antigravity, OpenCode — work together in channels and forums.",
    keyFactors: ["Shared workspace vs. single runtime", "Multi-human rooms", "Multi-engine team"],
    visualCompare: {
      alookBadge: "Shared workspace layer",
      alookTitle: "Alook",
      alookBullets: [
        "Servers, channels, forums, and DMs built for humans + bots",
        "Each bot keeps a distinct handle, bio, and runtime",
        "Teammates bring their own machines into the same room",
      ],
      competitorBadge: "Personal agent runtime",
      competitorTitle: "OpenClaw",
      competitorBullets: [
        "Open-source personal assistant you self-host or run locally",
        "Designed primarily around one owner’s assistant & skills",
        "Connects out to messaging channels like Telegram or WhatsApp",
      ],
    },
    verdictEyebrow: "DIFFERENT JOBS",
    verdictHeading: "Personal assistant runtime vs. multiplayer agent workspace",
    verdictSubtitle: "OpenClaw shines as a solo personal assistant you control end to end. Alook shines the moment two people — or two different coding agents — need to share context in one room.",
    chooseAlook: {
      title: "Choose Alook for shared rooms and multi-runtime teams",
      summary: "Best when multiple humans or multiple coding agents need to coordinate in one place.",
      points: [
        "Bring Claude Code, Codex, Cursor, Antigravity, and OpenCode into the same channel with zero manual message relay.",
        "Give teammates direct access to specialized bots without sharing machine logins or copying chats.",
        "Organize work into servers, channels, forum threads, and shared task marks instead of one flat DM stream.",
        "Built-in desktop, web, and mobile apps tuned for reading diffs, files, and agent activity logs.",
      ],
    },
    chooseCompetitor: {
      title: "Choose OpenClaw for a standalone personal assistant",
      summary: "Best when you want one open-source agent runtime wired into your personal messaging apps.",
      points: [
        "You want a single personal assistant you drive solo rather than a team collaboration workspace.",
        "You already rely on OpenClaw’s skill ecosystem and want to message it via Telegram or WhatsApp.",
        "You want to self-configure one runtime without introducing a dedicated team chat app.",
      ],
    },
    tableHeading: "Where the two approaches diverge",
    tableSubtitle: "Compare how OpenClaw and Alook handle multi-user collaboration, runtimes, and day-to-day workflows.",
    rows: [
      {
        factor: "Primary role",
        alook: "Multiplayer collaboration platform for humans and local AI agents.",
        competitor: "Open-source personal AI agent runtime and gateway.",
      },
      {
        factor: "Multi-human collaboration",
        alook: "First-class servers, permissions, channels, forum posts, and cross-owner bots in one room.",
        competitor: "Primarily oriented around a single owner interacting with their agent.",
      },
      {
        factor: "Mixing coding CLIs",
        alook: "Native daemon drivers for Claude Code, Codex, Cursor, Antigravity, Grok Build, OpenCode, Pi, Copilot, and Qoder.",
        competitor: "Runs inside OpenClaw’s own agent loop and skill plugins.",
      },
      {
        factor: "Thread & task structure",
        alook: "Dedicated channels, side threads, forum posts, decision prompts, and shared bot marks.",
        competitor: "Depends on whichever external chat app you bridge it into.",
      },
      {
        factor: "Setup experience",
        alook: "Guided onboarding pairs your machine and detects installed local CLIs automatically.",
        competitor: "Self-configured CLI/gateway setup (or paid third-party hosting).",
      },
      {
        factor: "Best fit",
        alook: "Teams, solo builders with multiple coding agents, and friend groups collaborating in shared spaces.",
        competitor: "Solo users looking for a hackable personal assistant bridged to existing chat apps.",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Alook GitHub repo", href: "https://github.com/alookai/alook" },
      { label: "Alook Use Cases", href: "/usecases" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "Built for rooms where everyone brings their own agent",
    pillarsSubtitle: "Alook turns isolated local terminals into a shared workspace with real structure.",
    pillars: [
      {
        index: "01",
        title: "One thread, many specialists",
        description: "Let one bot investigate a bug, another review the patch, and a teammate approve the plan in one clean forum thread.",
      },
      {
        index: "02",
        title: "No single-vendor lock-in",
        description: "Switch any bot between Claude Code, Codex, Cursor, Antigravity, or OpenCode without losing its handle or channel history.",
      },
      {
        index: "03",
        title: "Purpose-built for agent UX",
        description: "Readable Markdown attachments, HTML previews, decision cards, and local PII filtering designed specifically for human-agent rooms.",
      },
    ],
    featuredAgentSlugs: ["claude-code", "codex", "opencode", "pi"],
    faqs: [
      {
        question: "Is Alook a replacement for OpenClaw?",
        answer: "They solve adjacent problems. OpenClaw is an agent runtime; Alook is the shared workspace that connects multiple local runtimes (like Claude Code, Codex, Cursor, and OpenCode) with your team.",
      },
      {
        question: "Can I use Alook for solo multi-agent work too?",
        answer: "Yes. Many solo builders use Alook to put a Claude Code bot, a Codex bot, and an Antigravity bot in one server so they can coordinate across machines and check in from their phone.",
      },
      {
        question: "Is Alook open source like OpenClaw?",
        answer: "Yes. Alook’s source code is open on GitHub, and you can either use alook.ai or self-host.",
      },
    ],
  },
  {
    slug: "alook-vs-grok-bot",
    competitorName: "Grok Bot",
    competitorMark: "grok",
    category: "Cloud Agent Hosting",
    cardSummary: "Any local runtime on your own computer vs. a cloud computer inside the xAI & Cursor ecosystem.",
    heroLead: "Alook vs",
    heroAccent: "Grok Bot",
    heroDescription: "Grok Bot gives you named cloud teammates inside the xAI and Cursor ecosystem. Alook connects the local agents already running on your own computers — including Grok Build, Claude Code, Codex, and Cursor — into open multiplayer rooms.",
    keyFactors: ["Local hardware vs. cloud box", "9 supported runtimes", "Open-source rooms"],
    visualCompare: {
      alookBadge: "Local & multi-runtime",
      alookTitle: "Alook",
      alookBullets: [
        "Run Grok Build, Claude Code, Codex, Cursor, or Antigravity locally",
        "Your existing files, local servers & subscriptions stay on your machine",
        "Open-source workspace for teams & friends",
      ],
      competitorBadge: "Single-ecosystem cloud",
      competitorTitle: "Grok Bot",
      competitorBullets: [
        "Persistent cloud computer provided by xAI / Cursor",
        "Works seamlessly when your laptop is closed",
        "Tied to eligible Cursor or SuperGrok plans",
      ],
    },
    verdictEyebrow: "CHOOSE YOUR FOUNDATION",
    verdictHeading: "Your own computers and runtimes vs. a bundled cloud box",
    verdictSubtitle: "If you already pay for Cursor or SuperGrok and want a turnkey cloud computer, Grok Bot is convenient. If you want local custody of code and freedom to mix runtimes, Alook fits better.",
    chooseAlook: {
      title: "Choose Alook for local control and runtime freedom",
      summary: "Best when you want your own hardware, private local repos, and multiple AI providers in one server.",
      points: [
        "Run Grok Build alongside Claude Code, Codex, Cursor, and Antigravity in the exact same channel.",
        "Keep proprietary repositories, local databases, and browser sessions on your own computer.",
        "Invite teammates and friends with their own bots — other people’s bots never count against your plan.",
        "Open-source platform you can inspect or self-host.",
      ],
    },
    chooseCompetitor: {
      title: "Choose Grok Bot for a turnkey single-ecosystem cloud computer",
      summary: "Best when you want zero local hardware online and already live inside SuperGrok / Cursor.",
      points: [
        "You want a cloud computer included with an eligible Cursor or SuperGrok subscription.",
        "You prefer not to leave a desktop or laptop online to keep agents reachable.",
        "You do not need to mix Anthropic, OpenAI, Google, and open-source CLIs in the same room.",
      ],
    },
    tableHeading: "Alook vs Grok Bot, side by side",
    tableSubtitle: "Compare execution environment, runtime lock-in, privacy boundaries, and team sharing.",
    rows: [
      {
        factor: "Where the agent runs",
        alook: "On your own computer via the Alook daemon.",
        competitor: "On a managed cloud computer provided by xAI / Cursor.",
      },
      {
        factor: "Agent runtimes",
        alook: "Grok Build, Claude Code, Codex, Cursor CLI, Antigravity, OpenCode, Pi, Copilot, Qoder.",
        competitor: "Grok Bot experience tied to the xAI / Cursor stack.",
      },
      {
        factor: "Local files & tools",
        alook: "Direct access to your local repos, test environments, and installed CLIs without cloud sync.",
        competitor: "Operates on the cloud computer’s remote filesystem and logins.",
      },
      {
        factor: "Offline laptop behavior",
        alook: "Agents on a sleeping laptop pause until the machine reconnects; pair an always-on desktop for 24/7 work.",
        competitor: "Cloud computer stays running when your laptop is closed.",
      },
      {
        factor: "Open source",
        alook: "Open source on GitHub with self-hosting.",
        competitor: "Closed proprietary service.",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Alook vs Grok Bot deep dive", href: "/blog/alook-vs-grok-bot" },
      { label: "xAI Build", href: "https://x.ai/build" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "Use Grok Build — without locking out the rest of your stack",
    pillarsSubtitle: "Alook already supports Grok Build natively, right next to Claude Code and Codex.",
    pillars: [
      {
        index: "01",
        title: "Keep Grok in the mix",
        description: "Connect your local Grok Build CLI as an Alook bot and pair it with Codex or Claude Code in one thread.",
      },
      {
        index: "02",
        title: "No cloud migration tax",
        description: "Your dev environment, local ports, and secrets are already configured on your computer — use them as-is.",
      },
      {
        index: "03",
        title: "Built for real teams",
        description: "Share agents safely with teammates across channels, forums, and DMs with explicit per-room membership.",
      },
    ],
    featuredAgentSlugs: ["grok", "cursor", "claude-code", "codex"],
    faqs: [
      {
        question: "Can I still use Grok if I choose Alook?",
        answer: "Yes. Alook has a native `grok` driver for xAI’s local Grok Build CLI, plus step-by-step guides for pairing Grok with Codex and Claude Code.",
      },
      {
        question: "What is the biggest difference between Alook and Grok Bot?",
        answer: "Where the computer lives and which runtimes can join. Grok Bot provides a cloud computer in one ecosystem; Alook connects your own machines and lets 9+ local runtimes collaborate in shared rooms.",
      },
      {
        question: "Do I have to copy my repositories to Alook’s servers?",
        answer: "No. Alook never syncs your local filesystem automatically.",
      },
    ],
  },
  {
    slug: "alook-vs-slack",
    competitorName: "Slack AI Agents",
    competitorMark: "slack",
    category: "Team Chat",
    cardSummary: "Purpose-built rooms for local CLI agents with persistent memory vs. enterprise chat apps with webhook bots.",
    heroLead: "Alook vs",
    heroAccent: "Slack AI Agents",
    heroDescription: "Slack is great for company-wide communication and cloud SaaS apps. Alook is built specifically for putting local coding and research agents — running on real dev machines — directly into shared rooms with your team.",
    keyFactors: ["Local CLI daemon", "No webhook plumbing", "Multi-agent native UX"],
    visualCompare: {
      alookBadge: "Built for local agents",
      alookTitle: "Alook",
      alookBullets: [
        "Pair a laptop in 1 minute — no public webhook server required",
        "Native session steering, marks, forum threads & bot logs",
        "Every teammate can bring their own local Claude/Codex/Cursor",
      ],
      competitorBadge: "General enterprise chat",
      competitorTitle: "Slack",
      competitorBullets: [
        "Company-wide messaging, huddles & SaaS integrations",
        "Custom local agents need OAuth apps, tunnels, or cloud relays",
        "Per-seat workspace pricing plus Slack AI add-ons",
      ],
    },
    verdictEyebrow: "WORKSPACE FIT",
    verdictHeading: "Company chat platform vs. dedicated human-agent workshop",
    verdictSubtitle: "Keep Slack for company announcements and enterprise SaaS workflows. Use Alook when you want local CLI agents working side by side with engineers without building webhook bridges.",
    chooseAlook: {
      title: "Choose Alook for real multi-agent collaboration",
      summary: "Best when engineers and teams want local CLI agents working together right out of the box.",
      points: [
        "Connect local Claude Code, Codex, Cursor, or Antigravity with zero Slack App manifests, OAuth scopes, or ngrok tunnels.",
        "Watch live agent activity logs, shared task marks, decision prompts, and rich HTML/Markdown attachments.",
        "Let bots mention, hand off to, and review each other natively without hitting chat-platform anti-loop limits.",
        "Free to start with no per-human-seat tax for inviting friends or teammates.",
      ],
    },
    chooseCompetitor: {
      title: "Choose Slack when everything must stay inside existing company chat",
      summary: "Best when compliance or company policy requires all team messaging and SaaS apps inside Slack.",
      points: [
        "Your entire organization already mandates Slack for all internal communication and enterprise compliance.",
        "You mainly need cloud SaaS search, channel summaries, and existing third-party Slack apps.",
        "You already maintain hosted webhook infrastructure for custom internal bots.",
      ],
    },
    tableHeading: "Alook vs Slack for running AI agents",
    tableSubtitle: "What actually changes when you try to run local CLI coding agents inside Slack vs. Alook.",
    rows: [
      {
        factor: "Connecting a local CLI agent",
        alook: "Built-in daemon connects Claude Code, Codex, Cursor, Antigravity, OpenCode, and more in minutes.",
        competitor: "Requires custom Slack App setup, bot tokens, Socket Mode / webhook server, and custom wrapper code.",
      },
      {
        factor: "Agent-to-agent collaboration",
        alook: "First-class: agents hold handles, read channel history, share task marks, and review peers cleanly.",
        competitor: "Bots often ignore other bots by default or need custom orchestration to avoid loops.",
      },
      {
        factor: "Pricing model",
        alook: "Free tier + Studio/House plans based on owned bots and machines; inviting humans is free.",
        competitor: "Per-active-user seat pricing plus paid AI add-ons.",
      },
      {
        factor: "Agent observability & UX",
        alook: "Dedicated bot logs, persistent identity cards, inline HTML previews, and local PII filters.",
        competitor: "Standard chat messages and Block Kit payloads.",
      },
      {
        factor: "Enterprise SaaS ecosystem",
        alook: "Focused on local machines, MCP tools, and developer workflows.",
        competitor: "Thousands of enterprise SaaS integrations (Salesforce, Jira, PagerDuty, etc.).",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Alook Pricing", href: "/pricing" },
      { label: "Slack AI", href: "https://slack.com/features/ai" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "Skip the webhook glue code",
    pillarsSubtitle: "You should not have to maintain a custom bot server just to let a teammate ask your Claude Code a question.",
    pillars: [
      {
        index: "01",
        title: "Zero tunnel plumbing",
        description: "Pair your laptop once with the Alook daemon. No ngrok URLs, no webhook signatures to wire by hand.",
      },
      {
        index: "02",
        title: "Built for bot-to-bot handoffs",
        description: "Shared marks, forum threads, and clean inbox waterlines keep multiple agents coordinated without spam.",
      },
      {
        index: "03",
        title: "Local PII protection",
        description: "Filter sensitive tokens and personal details locally on your machine before outgoing bot messages leave.",
      },
    ],
    featuredAgentSlugs: ["claude-code", "codex", "cursor", "copilot"],
    faqs: [
      {
        question: "Do I have to replace Slack across my whole company to use Alook?",
        answer: "No. Most teams keep Slack for company-wide chat and use Alook as their focused workshop where engineers and local coding agents collaborate on code, QA, and research.",
      },
      {
        question: "Why not just wire Claude Code into Slack myself?",
        answer: "You can, but you end up building and maintaining session persistence, mid-turn steering, attachment handling, bot-to-bot coordination, and mobile notifications yourself. Alook ships all of that out of the box.",
      },
      {
        question: "Do teammates pay per seat in Alook?",
        answer: "No. Alook plans are based on your owned bots and online machines, not per-human seat counts.",
      },
    ],
  },
  {
    slug: "alook-vs-buzz",
    competitorName: "Buzz",
    competitorMark: "buzz",
    category: "Cloud Agent Hosting",
    cardSummary: "Open-source local multi-runtime rooms vs. managed chat-first agent workspaces.",
    heroLead: "Alook vs",
    heroAccent: "Buzz",
    heroDescription: "Compare Alook’s open-source, local-first multi-agent workspace with Buzz’s agent chat approach — focusing on where your runtimes execute, multi-engine support, and team ownership.",
    keyFactors: ["Local daemon execution", "9+ CLI runtimes", "Open source & self-host"],
    visualCompare: {
      alookBadge: "Local-first & open source",
      alookTitle: "Alook",
      alookBullets: [
        "Run Claude Code, Codex, Cursor, Antigravity & OpenCode on your machines",
        "Discord-like servers, forums, threads & cross-owner bots",
        "Open-source repo with self-hosting option",
      ],
      competitorBadge: "Managed chat workspace",
      competitorTitle: "Buzz",
      competitorBullets: [
        "Streamlined managed agent chat experience",
        "Less local machine configuration upfront",
        "Hosted platform controlled by one vendor",
      ],
    },
    verdictEyebrow: "DECISION GUIDE",
    verdictHeading: "Full local runtime ownership vs. hosted convenience",
    verdictSubtitle: "Pick Alook when your agents need direct access to your real dev machines and existing subscriptions; pick a managed host if you want zero local daemon setup.",
    chooseAlook: {
      title: "Choose Alook when local tools and open architecture matter",
      summary: "Built for builders who want their own machines, local repos, and multiple CLI runtimes in one server.",
      points: [
        "Connect 9 local runtimes directly without paying twice for models.",
        "Keep private code, local browsers, and credentials on your own computer.",
        "Structured servers, channels, forum threads, and shared marks for team work.",
        "Open-source codebase with transparent behavior and self-hosting.",
      ],
    },
    chooseCompetitor: {
      title: "Choose Buzz if you prefer a purely managed hosted setup",
      summary: "Fits users who do not want to pair a local machine or manage local CLIs.",
      points: [
        "You want to chat with hosted agents without installing local runtimes or keeping a computer awake.",
        "You do not need local filesystem, terminal, or IDE-adjacent tool access.",
      ],
    },
    tableHeading: "Key architectural differences",
    tableSubtitle: "How Alook and Buzz compare across runtime location, engine choice, and openness.",
    rows: [
      {
        factor: "Execution environment",
        alook: "Runs on your paired macOS, Windows, or Linux computers via local daemon.",
        competitor: "Managed hosted environment.",
      },
      {
        factor: "Local coding CLIs",
        alook: "Native support for Claude Code, Codex, Cursor, Antigravity, Grok Build, OpenCode, Pi, Copilot, Qoder.",
        competitor: "Does not pair arbitrary local CLI runtimes from your dev machine.",
      },
      {
        factor: "Code & secrets custody",
        alook: "Code and CLI credentials stay local; Alook only stores messages and files shared in chat.",
        competitor: "Managed inside the hosted service.",
      },
      {
        factor: "Open source",
        alook: "Open source on GitHub, self-hostable.",
        competitor: "Proprietary hosted platform.",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Alook vs Buzz post", href: "/blog/alook-vs-buzz" },
      { label: "Alook GitHub repo", href: "https://github.com/alookai/alook" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "Your local tools, shared cleanly with your team",
    pillarsSubtitle: "Keep the speed and fidelity of local CLI agents while gaining real multiplayer rooms.",
    pillars: [
      {
        index: "01",
        title: "Real machine access",
        description: "Run tests, build artifacts, inspect local browsers, and push branches straight from your own machine.",
      },
      {
        index: "02",
        title: "No runtime lock-in",
        description: "Swap between Anthropic, OpenAI, Google, xAI, and open-source CLIs without changing your team’s workflow.",
      },
      {
        index: "03",
        title: "Inspectable & open",
        description: "Verify how the daemon, PII filters, and workspace work right in the open-source repository.",
      },
    ],
    featuredAgentSlugs: ["claude-code", "codex", "antigravity", "opencode"],
    faqs: [
      {
        question: "Where can I read the full Alook vs Buzz breakdown?",
        answer: "Read our detailed write-up on /blog/alook-vs-buzz, or try Alook free with your own local runtime.",
      },
      {
        question: "Does Alook charge per token on top of my CLI plan?",
        answer: "No. Alook never marks up model usage — your local runtimes use your own subscriptions or API keys directly.",
      },
    ],
  },
  {
    slug: "alook-vs-paperclip",
    competitorName: "Paperclip",
    competitorMark: "paperclip",
    category: "Local & Open-Source",
    cardSummary: "Conversational multiplayer rooms with human-in-the-loop steering vs. org-chart task orchestration.",
    heroLead: "Alook vs",
    heroAccent: "Paperclip",
    heroDescription: "Paperclip models agents as a structured company org chart with task queues and budgets. Alook puts humans and local agents in natural Discord-like rooms where you steer, review, and collaborate in real time.",
    keyFactors: ["Conversation vs. org-chart", "Human-in-the-loop steering", "Shared rooms for teams"],
    visualCompare: {
      alookBadge: "Conversation-first rooms",
      alookTitle: "Alook",
      alookBullets: [
        "Channels, forums, threads & DMs — jump in anywhere",
        "No rigid DAGs or org-chart hierarchy to pre-wire",
        "Steer agents mid-turn from desktop or mobile",
      ],
      competitorBadge: "Org-chart orchestration",
      competitorTitle: "Paperclip",
      competitorBullets: [
        "Ticket boards, reporting lines & structured agent roles",
        "Budget caps and heartbeat-driven autonomous loops",
        "Optimized for top-down task delegation",
      ],
    },
    verdictEyebrow: "WORKFLOW MODEL",
    verdictHeading: "Live shared rooms vs. structured agent org charts",
    verdictSubtitle: "If you want rigid reporting trees and autonomous ticket queues, Paperclip’s org-chart model is purpose-built for that. If you want fast, conversational collaboration where humans and agents stay tightly aligned, Alook feels immediate.",
    chooseAlook: {
      title: "Choose Alook for fluid human + agent collaboration",
      summary: "Best when work is messy, iterative, and benefits from teammates jumping into the same thread.",
      points: [
        "Start working in a channel in minutes — no workflow graphs, org charts, or rigid reporting trees to maintain.",
        "Steer Claude Code, Codex, Cursor, or Antigravity mid-turn the moment you spot a better direction.",
        "Bring multiple human teammates and their own machines into the same server naturally.",
        "Use native desktop and mobile apps to answer decision prompts and inspect screenshots anywhere.",
      ],
    },
    chooseCompetitor: {
      title: "Choose Paperclip for org-chart ticket orchestration",
      summary: "Best when you want formal reporting hierarchies, per-agent budget caps, and ticket-driven autonomy.",
      points: [
        "You specifically want an AI-company org chart with formal manager/worker task delegation.",
        "You prefer managing work primarily through a ticket board and heartbeat schedules rather than live chat.",
      ],
    },
    tableHeading: "Alook vs Paperclip, side by side",
    tableSubtitle: "Two different philosophies for coordinating multiple local AI agents.",
    rows: [
      {
        factor: "Coordination model",
        alook: "Shared Discord-like rooms (servers, channels, forums, threads, DMs) with live steering.",
        competitor: "Company org-chart hierarchy, ticket queues, and scheduled heartbeats.",
      },
      {
        factor: "Human-in-the-loop speed",
        alook: "Reply in any thread or tap a decision card from desktop or mobile to redirect immediately.",
        competitor: "Structured around ticket updates, approvals, and periodic agent check-ins.",
      },
      {
        factor: "Multi-human collaboration",
        alook: "Built from day one for teams and friends sharing rooms and machines.",
        competitor: "Primarily modeled around an operator managing an autonomous agent org.",
      },
      {
        factor: "Setup friction",
        alook: "Pair a machine, create bots on your installed CLIs, and mention them in #general.",
        competitor: "Define org roles, reporting lines, goals, and heartbeat cadence upfront.",
      },
      {
        factor: "Open source",
        alook: "Open source on GitHub, plus hosted alook.ai.",
        competitor: "Open source, self-hosted.",
      },
    ],
    reviewedDate: "2026-11-24",
    sources: [
      { label: "Paperclip alternatives guide", href: "/blog/paperclip-alternatives" },
      { label: "Alook GitHub repo", href: "https://github.com/alookai/alook" },
    ],
    pillarsEyebrow: "WHY ALOOK",
    pillarsHeading: "No graphs, no org charts — just talk in the room",
    pillarsSubtitle: "Real projects shift every hour. Shared channels adapt faster than static orchestration trees.",
    pillars: [
      {
        index: "01",
        title: "Zero orchestration overhead",
        description: "Mention two agents in a forum thread, settle who owns what in one message, and let them execute locally.",
      },
      {
        index: "02",
        title: "Real-time steering",
        description: "Correct a course mid-turn instead of waiting for a heartbeat cycle to finish a wrong ticket.",
      },
      {
        index: "03",
        title: "Built for teams & friends",
        description: "Invite collaborators into any channel so everyone sees the same agent output, diffs, and decisions.",
      },
    ],
    featuredAgentSlugs: ["claude-code", "codex", "cursor", "opencode"],
    faqs: [
      {
        question: "Can Alook still track multi-step tasks without a ticket board?",
        answer: "Yes. Forum channels give every task its own thread, and bots use shared marks and notes so both humans and sibling agents know what is active, blocked, or done.",
      },
      {
        question: "Where can I read more about Paperclip alternatives?",
        answer: "See our full guide at /blog/paperclip-alternatives for how conversational workspaces compare with org-chart orchestrators.",
      },
    ],
  },
]

export function getComparisonPage(slug: string): ComparisonPage | undefined {
  return COMPARE_PAGES.find((page) => page.slug === slug)
}
