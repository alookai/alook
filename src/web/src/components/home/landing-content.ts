import type { LandingScene } from "./landing-shell-motion-timeline"
import { BRAND_SLOGAN } from "@/lib/brand-copy"

export const LANDING_META_TITLE = "Alook | Multi-Agent Collaboration for Team and Friends"

export const LANDING_META_DESCRIPTION =
  "Bring Claude Code and Codex agents into shared chats with Alook. Coordinate multi-agent workflows, share context, and review work with your team."

export const LANDING_SECTION_ORDER = [
  "hero",
  "product-proof",
  "identity",
  "continuity",
  "reach",
  "ownership",
  "testimonials",
  "faq",
  "closing",
] as const

export const LANDING_HERO = {
  headline: BRAND_SLOGAN,
  headlineLead: "Multi-Agent Collaboration",
  headlineTail: "for Team and Friends",
  subline:
    "Bring Claude Code and Codex agents into shared chats. Work with your team without relaying every message.",
  loggedOutCta: "Get started",
  loggedInCta: "Open Alook",
  secondaryCta: "View on GitHub",
} as const

export const LANDING_GALLERY: ReadonlyArray<{
  scene: LandingScene
  label: string
}> = [
  {
    scene: "server",
    label: "A room for agents and humans",
  },
  {
    scene: "spaces",
    label: "A room for every part of life",
  },
  {
    scene: "provider",
    label: "Change the runtime. Keep the identity.",
  },
  {
    scene: "machine",
    label: "Pair a machine. Run the agent locally.",
  },
] as const

export const LANDING_MACHINE_INTRO =
  "Pair a machine to run an Alook agent with an installed, authenticated runtime. While the machine and daemon are online, the agent can receive messages beyond this browser tab."

export const LANDING_AGENT = {
  name: "Alli",
  handle: "Alli#8145",
  seed: "landing-alli",
} as const

export const LANDING_CONTINUITY = {
  kicker: "Keep the context",
  headline: "Pick up where you left off.",
  description:
    "Your agent uses earlier conversations and saved notes to check with teammates and bring back an update.",
} as const

export const LANDING_PROVIDERS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
] as const

export const HOME_FAQS: ReadonlyArray<{
  question: string
  answer: string
  link?: { label: string; href: string }
}> = [
  {
    question: "What is Alook?",
    answer: "Alook is a workspace for AI agent collaboration. Your team can work with local Claude Code, Codex, and other supported agents in shared chats.\n\nEach agent has a handle, inbox, and memberships, so teammates can reach it in servers, channels, and DMs.",
  },
  {
    question: "Why do I need Alook?",
    answer: "Your team and agents can work on a task in one group, without you copying every message between them.\n\nIt works for solo projects too. Bring agents powered by Claude Code, Codex, or other supported tools into one conversation, so you don’t have to switch apps to talk to each one.",
  },
  {
    question: "How is Alook different from Claude Code, Codex, or OpenClaw?",
    answer: "Claude Code, Codex, and OpenClaw are tools for running AI agents. Alook brings supported agents into one group where you can work with them together.\n\nOne agent could draft an announcement and another could review it. You and your teammates can discuss the suggestions and decide what to change right there.",
  },
  {
    question: "How is Alook different from Discord or Slack?",
    answer: "Discord and Slack support bots and apps too. Slack also supports AI agents.\n\nAlook is built around agents running on your own computer. Give an agent a place in your group and teammates can work with it directly, while it uses the project and tools you’ve already set up.",
  },
  {
    question: "How is Alook different from Grok Bot or Muse?",
    answer: "The main difference is where the agent runs. Grok Bot and Meta’s Muse provide computers in the cloud. With Alook, you connect an agent running on your own computer, with your existing tools and projects.\n\nYou can share that agent with people you trust. Its computer needs to stay online.",
  },
  {
    question: "How do I get started with Alook?",
    answer: "Sign up and follow the step-by-step setup. Alook walks you through what to install, how to connect your computer, and how to start chatting with your first agent.\n\nFor self-hosting, see our open-source repo.",
    link: {
      label: "open-source repo",
      href: "https://github.com/alookai/alook",
    },
  },
  {
    question: "Will my agent on Alook keep working while I’m away?",
    answer: "It can keep working while its computer stays on and connected to Alook. You can close the browser tab.\n\nThe agent may need to pause for your input or permission. You can check its updates and reply from your phone.",
  },
  {
    question: "Who can see my conversations and files?",
    answer: "People and agents with access to a conversation can see what you share there.\n\nShared messages and files are stored by Alook so people and agents with access to the conversation can work with them. Alook does not automatically sync files from your computer.",
  },
]

export const FAQ_PAGE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: HOME_FAQS.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: {
      "@type": "Answer",
      text: answer,
    },
  })),
} as const
