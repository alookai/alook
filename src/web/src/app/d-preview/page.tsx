"use client"

/**
 * Discord-clone STYLE PREVIEW — mock data only, fixed URL /d-preview.
 * Not wired to any API. Built to validate the visual direction from
 * plans/discord-v0.1.md: Discord layout + Alook design tokens.
 *
 * Everything resolves through Alook semantic tokens (globals.css) so it
 * adapts to light/dark. The one token Alook lacks — a surface deeper than
 * --sidebar for the server rail — is scoped locally below as --d-rail.
 *
 * Covers two things from the plan:
 *  #1 Three responsive stages — desktop (≥961) / tablet (601–960) / mobile (≤600).
 *  #2 A wider feature showcase — markdown, mentions, system messages, threads,
 *     pinned / search / thread side panels, typing indicator.
 */

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import EmojiMartPicker from "@emoji-mart/react"
import emojiMartData from "@emoji-mart/data"
import {
  Hash, Plus, Bell, Pin, Users, Search, Smile, PlusCircle,
  ChevronDown, ChevronLeft, Reply, SmilePlus, Pencil, MoreHorizontal,
  Sun, Moon, Inbox, MessagesSquare, Menu, X, UserPlus, ChevronRight,
  Image as ImageIcon, FileText, Download, Settings, Trash2, Shield, Link2,
  ScrollText, Check, AtSign, BellOff, Copy, CheckSquare, Square,
} from "lucide-react"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, useDroppable,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import { CSS } from "@dnd-kit/utilities"

// ── Mock data ───────────────────────────────────────────────────────────
const SERVERS = [
  { id: "sv_alook", name: "Alook", initial: "A", active: true, unread: false, mentions: 0 },
  { id: "sv_cf", name: "Cloudflare", initial: "CF", active: false, unread: true, mentions: 3 },
  { id: "sv_oss", name: "OSS Club", initial: "OS", active: false, unread: false, mentions: 0 },
]

type Channel = { id: string; name: string; active: boolean; unread: boolean; muted?: boolean; type?: "text" | "forum" }
const CATEGORIES: { name: string; channels: Channel[] }[] = [
  {
    name: "WELCOME",
    channels: [
      { id: "welcome", name: "welcome", active: true, unread: false },
      { id: "rules", name: "rules", active: false, unread: false },
    ],
  },
  {
    name: "COMMUNITY",
    channels: [
      { id: "general", name: "general", active: false, unread: false },
      { id: "show-and-tell", name: "show-and-tell", active: false, unread: true },
      { id: "ideas-feedback", name: "ideas-feedback", active: false, unread: false },
      { id: "help-forum", name: "help-forum", active: false, unread: false, type: "forum" },
    ],
  },
  {
    name: "DEVELOPERS",
    channels: [
      { id: "dev-chat", name: "dev-chat", active: false, unread: false },
      { id: "api", name: "api-integrations", active: false, unread: false },
      { id: "off-topic", name: "off-topic", active: false, unread: true, muted: true },
    ],
  },
]

type Attachment =
  | { kind: "image"; name: string }
  | { kind: "file"; name: string; size: string }

type Msg = {
  id: string
  type?: "system"
  systemKind?: "join" | "thread"
  author?: string
  color?: string
  time?: string
  avatar?: string
  webhook?: boolean
  failed?: boolean
  body?: string
  edited?: boolean
  embed?: {
    provider: string
    title: string
    desc: string
    color?: string
    image?: boolean // render the faux OG poster
    fields?: { name: string; value: string; inline?: boolean }[]
    footer?: string
    author?: { name: string; avatar: string }
  }
  attachments?: Attachment[]
  reactions?: { emoji: string; count: number; me: boolean }[]
  reply?: { author: string; text: string }
  thread?: { id: string; name: string; count: number }
  grouped?: boolean
}

const MESSAGES: Msg[] = [
  {
    id: "m1", author: "Gener", color: "var(--foreground)", time: "5/11/26, 9:27 PM",
    avatar: "G",
    body: "👋 Welcome to the Alook Community!\n\nAlook lets you run your own AI-powered personal company — agents that collaborate, stay always on, and learn from every task.",
    embed: {
      provider: "Alook", title: "Alook — Personal Company",
      desc: "Your AI agents, always on. Give them an email, let them work for you around the clock.",
      image: true,
    },
    reactions: [{ emoji: "👍", count: 3, me: true }],
    thread: { id: "thr_research", name: "Research team setup", count: 3 },
  },
  {
    id: "m2", author: "Gus", time: "9:31 PM", avatar: "Gu",
    body: "this is exactly what I needed — the email-per-agent thing is wild",
  },
  {
    id: "m3", author: "Gus", time: "9:31 PM", avatar: "Gu",
    body: "is there a template for a research team?",
    grouped: true,
  },
  {
    id: "m4", author: "Lindsay", time: "9:42 PM", avatar: "L",
    reply: { author: "Gus", text: "is there a template for a research team?" },
    body: "Yes — check the Templates page, there's a Research Analyst preset. Deploys in a minute.",
    edited: true,
    reactions: [{ emoji: "🔥", count: 2, me: false }, { emoji: "🙏", count: 1, me: false }],
  },
  {
    id: "m5", author: "Gener", time: "9:45 PM", avatar: "G",
    body: "Here's the **setup** in *three* steps:\n> Clone the repo first\n`pnpm install`\n```\npnpm dev --filter web\n```\nThat's it ~~maybe~~ ||it just works||",
  },
  {
    id: "ms1", type: "system", systemKind: "join", time: "9:46 PM",
    body: "Azzo joined the server.",
  },
  {
    id: "m6", author: "Gus", time: "9:48 PM", avatar: "Gu",
    body: "thanks @Lindsay — can you cross-post this in #general? cc @everyone",
  },
  {
    id: "m7", author: "Lindsay", time: "9:50 PM", avatar: "L",
    body: "here's the preset config + a screenshot of the result",
    attachments: [
      { kind: "image", name: "research-preset.png" },
      { kind: "file", name: "research-team.json", size: "4.2 KB" },
    ],
  },
  {
    id: "m8", webhook: true, author: "Release Notes", time: "9:55 PM", avatar: "RN",
    embed: {
      provider: "GitHub", title: "alook v0.1.0", color: "var(--primary)",
      author: { name: "alookai/alook", avatar: "GH" },
      desc: "Threads, forum channels, DMs, and emoji reactions are live. Full changelog below.",
      fields: [
        { name: "Added", value: "Threads, Forum channels, DMs", inline: true },
        { name: "Fixed", value: "SMTP timeout, hydration warnings", inline: true },
        { name: "Contributors", value: "@Gener, @Lindsay, @Gus", inline: false },
      ],
      footer: "Released 6/24/26 · 142 commits",
    },
  },
  {
    id: "m9", author: "Gener", time: "9:58 PM", avatar: "G",
    body: "trying the new preset now…", failed: true,
  },
]

// index in MESSAGES where the "NEW" unread divider sits (before this message)
const NEW_DIVIDER_BEFORE = "m6"

const PINNED = [MESSAGES[0], MESSAGES[3]] as Msg[]

const SEARCH_RESULTS = [MESSAGES[3], MESSAGES[1]] as Msg[]

type Thread = {
  id: string
  name: string
  count: number
  lastActive: string
  parent: { author: string; text: string }
  messages: Msg[]
}

const THREADS: Thread[] = [
  {
    id: "thr_research",
    name: "Research team setup",
    count: 3,
    lastActive: "9:36 PM",
    parent: { author: "Gener", text: "👋 Welcome to the Alook Community!" },
    messages: [
      { id: "t1", author: "Gus", time: "9:33 PM", avatar: "Gu", body: "what roles should the research team have?" },
      { id: "t2", author: "Lindsay", time: "9:35 PM", avatar: "L", body: "Analyst, Summarizer, and a Fact-checker works well. Give each its own `@inbox`." },
      { id: "t3", author: "Gener", time: "9:36 PM", avatar: "G", body: "nice — shipping that preset 🚀" },
    ],
  },
  {
    id: "thr_billing",
    name: "Billing & limits questions",
    count: 5,
    lastActive: "8:12 PM",
    parent: { author: "jgtech", text: "how do per-agent usage limits work?" },
    messages: [
      { id: "b1", author: "jgtech", time: "8:05 PM", avatar: "j", body: "is there a cap on messages per agent?" },
      { id: "b2", author: "Gener", time: "8:12 PM", avatar: "G", body: "Soft limits per plan — you can raise them in **Settings → Usage**." },
    ],
  },
  {
    id: "thr_selfhost",
    name: "Self-hosting on Cloudflare",
    count: 2,
    lastActive: "Yesterday",
    parent: { author: "distagon", text: "anyone running this on their own Workers account?" },
    messages: [
      { id: "s1", author: "lucky tomy", time: "Yesterday", avatar: "t", body: "yep — `wrangler deploy` and point D1 + R2 at your own buckets." },
    ],
  },
]

// ── Forum posts (a forum channel is a list of posts; each post is a thread) ──
type ForumPost = Thread & { avatar: string; tags: string[]; preview: string }
const FORUM_POSTS: Record<string, ForumPost[]> = {
  "help-forum": [
    {
      id: "fp_smtp", name: "Custom SMTP keeps timing out", avatar: "j", count: 6, lastActive: "12m ago",
      tags: ["email", "bug"], preview: "I set up a custom SMTP relay but sends time out after ~30s…",
      parent: { author: "jgtech", text: "I set up a custom SMTP relay but sends time out after ~30s. Anyone seen this?" },
      messages: [
        { id: "fp_smtp_1", author: "jgtech", time: "1:02 PM", avatar: "j", body: "I set up a custom SMTP relay but sends time out after ~30s. Anyone seen this?" },
        { id: "fp_smtp_2", author: "Lindsay", time: "1:08 PM", avatar: "L", body: "Check the port — `587` with STARTTLS works, `465` sometimes hangs on Workers." },
        { id: "fp_smtp_3", author: "jgtech", time: "1:14 PM", avatar: "j", body: "587 fixed it 🙏 thank you!" },
      ],
    },
    {
      id: "fp_preset", name: "Share your best agent presets", avatar: "L", count: 23, lastActive: "1h ago",
      tags: ["showcase"], preview: "Drop your favorite agent setups here — let's build a library.",
      parent: { author: "Lindsay", text: "Drop your favorite agent setups here — let's build a library." },
      messages: [
        { id: "fp_preset_1", author: "Lindsay", time: "11:00 AM", avatar: "L", body: "Drop your favorite agent setups here — let's build a library." },
        { id: "fp_preset_2", author: "Gus", time: "11:20 AM", avatar: "Gu", body: "Research Analyst + Fact-checker combo has been 🔥 for me" },
      ],
    },
    {
      id: "fp_pricing", name: "How do per-agent limits scale?", avatar: "A", count: 4, lastActive: "3h ago",
      tags: ["question", "billing"], preview: "Trying to understand how message limits work across a team…",
      parent: { author: "Azzo", text: "Trying to understand how message limits work across a team of agents." },
      messages: [
        { id: "fp_pricing_1", author: "Azzo", time: "9:30 AM", avatar: "A", body: "Trying to understand how message limits work across a team of agents." },
        { id: "fp_pricing_2", author: "Gener", time: "9:45 AM", avatar: "G", body: "Limits are per-workspace, pooled across agents. Raise them in **Settings → Usage**." },
      ],
    },
  ],
}

const FORUM_TAGS = ["All", "question", "bug", "showcase", "email", "billing"]

const MEMBERS: Record<string, { name: string; avatar: string; status: "online" | "offline"; sub: string }[]> = {
  Admin: [
    { name: "Gener", avatar: "G", status: "online", sub: "" },
    { name: "Gus", avatar: "Gu", status: "online", sub: "" },
    { name: "Lindsay", avatar: "L", status: "online", sub: "" },
  ],
  Online: [
    { name: "lucky tomy", avatar: "t", status: "online", sub: "AI engineer" },
    { name: "jgtech", avatar: "j", status: "online", sub: "" },
  ],
  Offline: [
    { name: "Azzo", avatar: "A", status: "offline", sub: "" },
    { name: "distagon", avatar: "d", status: "offline", sub: "" },
    { name: "Reece", avatar: "R", status: "offline", sub: "" },
  ],
}

// ── DM / Friends mock ──────────────────────────────────────────────────────
type Friend = { id: string; name: string; avatar: string; status: "online" | "offline"; sub: string }

const FRIENDS: Friend[] = [
  { id: "u_gus", name: "Gus", avatar: "Gu", status: "online", sub: "Playing with agents" },
  { id: "u_lindsay", name: "Lindsay", avatar: "L", status: "online", sub: "Online" },
  { id: "u_tomy", name: "lucky tomy", avatar: "t", status: "online", sub: "AI engineer" },
  { id: "u_azzo", name: "Azzo", avatar: "A", status: "offline", sub: "Offline" },
  { id: "u_reece", name: "Reece", avatar: "R", status: "offline", sub: "Offline" },
]

const PENDING: { id: string; name: string; avatar: string; kind: "incoming" | "outgoing" }[] = [
  { id: "u_jg", name: "jgtech", avatar: "j", kind: "incoming" },
  { id: "u_dist", name: "distagon", avatar: "d", kind: "outgoing" },
]

const BLOCKED: { id: string; name: string; avatar: string }[] = [
  { id: "u_spam", name: "spammer42", avatar: "s" },
]

type DM = { id: string; name: string; avatar: string; status: "online" | "offline"; preview: string; unread?: boolean; messages: Msg[] }

const DMS: DM[] = [
  {
    id: "ddm_lindsay", name: "Lindsay", avatar: "L", status: "online",
    preview: "shipping that preset 🚀", unread: true,
    messages: [
      { id: "d1", author: "Lindsay", time: "9:50 PM", avatar: "L", body: "hey! saw your research preset — looks great" },
      { id: "d2", author: "Gener", time: "9:51 PM", avatar: "G", body: "thanks! still tuning the **fact-checker** role" },
      { id: "d3", author: "Lindsay", time: "9:52 PM", avatar: "L", body: "want me to test it on the Q2 report?" },
    ],
  },
  {
    id: "ddm_gus", name: "Gus", avatar: "Gu", status: "online",
    preview: "the email-per-agent thing is wild",
    messages: [
      { id: "g1", author: "Gus", time: "8:30 PM", avatar: "Gu", body: "can I forward an email straight to an agent?" },
      { id: "g2", author: "Gener", time: "8:31 PM", avatar: "G", body: "yep — each agent has its own address. just CC it." },
    ],
  },
  {
    id: "ddm_tomy", name: "lucky tomy", avatar: "t", status: "offline",
    preview: "wrangler deploy and you're set",
    messages: [
      { id: "y1", author: "lucky tomy", time: "Yesterday", avatar: "t", body: "self-hosting was easier than I expected" },
    ],
  },
]

// ── Profile card mock ────────────────────────────────────────────────────
type Profile = { name: string; avatar: string; role: string; about: string; mutual: number; tags: string[] }
const PROFILES: Record<string, Profile> = {
  Gener: { name: "Gener", avatar: "G", role: "Owner", about: "Building Alook. Coffee, agents, and warm gray UIs.", mutual: 3, tags: ["Owner"] },
  Gus: { name: "Gus", avatar: "Gu", role: "Admin", about: "Tinkering with email-driven workflows.", mutual: 2, tags: ["Admin"] },
  Lindsay: { name: "Lindsay", avatar: "L", role: "Admin", about: "Research lead. Ask me about presets.", mutual: 2, tags: ["Admin"] },
}

// ── Settings mock ──────────────────────────────────────────────────────────
type SettingsSection = "overview" | "members" | "invites" | "webhooks" | "notifications" | "audit"

const INVITES = [
  { code: "alook-x9f2", uses: "3 / ∞", expires: "in 7 days", by: "Gener" },
  { code: "alook-team", uses: "12 / 50", expires: "Never", by: "Lindsay" },
]

const WEBHOOKS = [
  { id: "whk_ci", name: "CI Bot", channel: "dev-chat", avatar: "CI" },
  { id: "whk_release", name: "Release Notes", channel: "general", avatar: "RN" },
]

const AUDIT_LOG = [
  { actor: "Gener", action: "created channel", target: "#api-integrations", time: "9:20 PM" },
  { actor: "Lindsay", action: "kicked member", target: "spammer42", time: "8:55 PM" },
  { actor: "Gus", action: "updated role", target: "lucky tomy → Admin", time: "8:40 PM" },
  { actor: "Gener", action: "deleted 12 messages", target: "#general", time: "Yesterday" },
]

// ── Mentions inbox (cross-server @-mentions of the current user) ────────────
type Mention = { id: string; server: string; channel: string; m: Msg }
const MENTIONS: Mention[] = [
  {
    id: "mn_1", server: "Alook", channel: "general",
    m: { id: "mn_m1", author: "Gus", time: "9:48 PM", avatar: "Gu", body: "thanks @Gener — can you cross-post this in #general? cc @everyone" },
  },
  {
    id: "mn_2", server: "Cloudflare", channel: "flagship",
    m: { id: "mn_m2", author: "roerohan", time: "8:43 PM", avatar: "r", body: "@Gener the Workers binding you mentioned fixed it 🙏" },
  },
  {
    id: "mn_3", server: "Alook", channel: "help-forum",
    m: { id: "mn_m3", author: "jgtech", time: "1:14 PM", avatar: "j", body: "@Gener 587 fixed the SMTP timeout, thank you!" },
  },
]

// inbox feed rows — "You have new messages in <server>" (For You / Unreads tabs)
const INBOX_FEED = [
  { id: "if_1", server: "memobase", initial: "ML", ago: "18d", unread: true },
  { id: "if_2", server: "OSS Club", initial: "OS", ago: "23d", unread: true },
  { id: "if_3", server: "Midjourney", initial: "MJ", ago: "1mo", unread: false },
  { id: "if_4", server: "Cloudflare", initial: "CF", ago: "2mo", unread: false },
  { id: "if_5", server: "Acontext", initial: "AI", ago: "2mo", unread: false },
]

type RightPanel = "members" | "pinned" | "search" | "threads" | null
type Breakpoint = "desktop" | "tablet" | "mobile"
type MobileZone = "rail" | "channels" | "messages"
type View = "server" | "dm" | "settings"

// ── Responsive ──────────────────────────────────────────────────────────
// Plan stages: mobile ≤600, tablet 601–960, desktop ≥961.
function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop")
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 600px)")
    const tablet = window.matchMedia("(min-width: 601px) and (max-width: 960px)")
    const compute = () => setBp(mobile.matches ? "mobile" : tablet.matches ? "tablet" : "desktop")
    compute()
    mobile.addEventListener("change", compute)
    tablet.addEventListener("change", compute)
    return () => {
      mobile.removeEventListener("change", compute)
      tablet.removeEventListener("change", compute)
    }
  }, [])
  return bp
}

// ── Bits ────────────────────────────────────────────────────────────────
function Avatar({ label, size = 40, dim = false }: { label: string; size?: number; dim?: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground select-none"
      style={{ width: size, height: size, fontSize: size * 0.4, opacity: dim ? 0.4 : 1 }}
    >
      {label}
    </div>
  )
}

const STATUS_COLOR = {
  online: "var(--status-online)",
  offline: "var(--status-offline)",
}

function PresenceDot({ status }: { status: "online" | "offline" }) {
  if (status === "offline") return null
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2"
      style={{ background: STATUS_COLOR[status], "--tw-ring-color": "var(--background)" } as React.CSSProperties}
    />
  )
}

// ── Inline + block markdown (mock renderer) ───────────────────────────────
function Spoiler({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <button
      onClick={() => setShown(true)}
      className={[
        "rounded-[4px] px-1 transition-colors",
        shown ? "bg-muted text-foreground" : "bg-foreground/80 text-transparent select-none",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

function MentionPill({ children, everyone }: { children: React.ReactNode; everyone?: boolean }) {
  return (
    <span
      className={[
        "rounded-[4px] px-1 font-medium",
        everyone ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
      ].join(" ")}
    >
      {children}
    </span>
  )
}

function ChannelPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-lg bg-accent px-1 font-medium text-foreground">
      <Hash className="size-3" />
      {String(children).replace(/^#/, "")}
    </span>
  )
}

const INLINE_RE = /(\*\*.+?\*\*|~~.+?~~|\*.+?\*|`.+?`|\|\|.+?\|\||@everyone|@here|@\w+|#[\w-]+)/g

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const t = m[0]
    const k = `${keyBase}-${i++}`
    if (t.startsWith("**")) nodes.push(<strong key={k}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith("~~")) nodes.push(<s key={k} className="opacity-70">{t.slice(2, -2)}</s>)
    else if (t.startsWith("`")) nodes.push(<code key={k} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em]">{t.slice(1, -1)}</code>)
    else if (t.startsWith("||")) nodes.push(<Spoiler key={k}>{t.slice(2, -2)}</Spoiler>)
    else if (t.startsWith("*")) nodes.push(<em key={k}>{t.slice(1, -1)}</em>)
    else if (t === "@everyone" || t === "@here") nodes.push(<MentionPill key={k} everyone>{t}</MentionPill>)
    else if (t.startsWith("@")) nodes.push(<MentionPill key={k}>{t}</MentionPill>)
    else if (t.startsWith("#")) nodes.push(<ChannelPill key={k}>{t}</ChannelPill>)
    last = m.index + t.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function MessageBody({ text }: { text: string }) {
  const lines = text.split("\n")
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith("```")) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i++ }
      i++ // skip closing fence
      blocks.push(
        <pre key={key++} className="my-1 overflow-x-auto thin-scrollbar rounded-md border border-border bg-muted p-3 font-mono text-[13px] leading-snug">
          <code>{buf.join("\n")}</code>
        </pre>,
      )
    } else if (line.startsWith("> ")) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith("> ")) { buf.push(lines[i].slice(2)); i++ }
      blocks.push(
        <blockquote key={key++} className="my-1 border-l-2 border-border pl-3 text-foreground/90">
          {buf.map((l, j) => <div key={j}>{renderInline(l, `${key}-q${j}`)}</div>)}
        </blockquote>,
      )
    } else {
      blocks.push(<div key={key++} className={line === "" ? "h-2" : ""}>{renderInline(line, `${key}`)}</div>)
      i++
    }
  }
  return <div className="whitespace-pre-wrap text-[15px] leading-[1.4]">{blocks}</div>
}

// ── Page ────────────────────────────────────────────────────────────────
export default function DiscordPreview() {
  const bp = useBreakpoint()
  const [view, setView] = useState<View>("server")
  const [activeChannel, setActiveChannel] = useState("welcome")
  const [activeDm, setActiveDm] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview")
  const [rightPanel, setRightPanel] = useState<RightPanel>("members")
  // An open thread takes over the message area like a channel (Discord behavior).
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false) // tablet left overlay
  const [mobileZone, setMobileZone] = useState<MobileZone>("messages")
  const [profile, setProfile] = useState<{ name: string; x: number; y: number } | null>(null)
  // avoid hydration mismatch: theme is unknown on the server
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // open a profile card near the click point (desktop popover / mobile sheet)
  const openProfile = (name: string, e: React.MouseEvent) => {
    if (PROFILES[name]) setProfile({ name, x: e.clientX, y: e.clientY })
  }
  const profileProps = { onOpenProfile: openProfile }

  const togglePanel = (k: Exclude<RightPanel, null>) =>
    setRightPanel((p) => (p === k ? null : k))

  // the active channel object (for forum detection) and the open thread/post.
  const activeChannelObj = CATEGORIES.flatMap((c) => c.channels).find((ch) => ch.id === activeChannel)
  const isForum = activeChannelObj?.type === "forum"
  const allThreads = [...THREADS, ...Object.values(FORUM_POSTS).flat()]
  const openThread = allThreads.find((t) => t.id === openThreadId) ?? null
  const dm = DMS.find((d) => d.id === activeDm) ?? null

  // header button → channel thread list (side panel); picking one → full message area.
  // also used to open a forum post (forum posts share the Thread shape).
  const enterThread = (id: string) => {
    setOpenThreadId(id)
    setRightPanel(null)
    if (bp === "mobile") setMobileZone("messages")
  }

  // rail: @me → DM/Friends view; a server → server view
  const goHome = () => { setView("dm"); setActiveDm(null); setOpenThreadId(null); if (bp === "mobile") setMobileZone("channels") }
  const goServer = () => { setView("server"); setOpenThreadId(null); if (bp === "mobile") setMobileZone("channels") }

  const enterDm = (id: string) => {
    setActiveDm(id)
    if (bp === "tablet") setSidebarOpen(false)
    if (bp === "mobile") setMobileZone("messages")
  }

  const panelProps = { onOpenThread: enterThread }

  const railProps = { setMobileZone, view, onHome: goHome, onServer: goServer }
  const channelProps = {
    activeChannel,
    setActiveChannel: (id: string) => {
      setActiveChannel(id)
      setOpenThreadId(null) // leaving the channel closes any open thread
      if (bp === "tablet") setSidebarOpen(false)
      if (bp === "mobile") setMobileZone("messages")
    },
    onOpenSettings: () => setView("settings"),
  }

  // The left sidebar — channels (server view) or DM list (@me view).
  const sidebar = (opts: { bordered?: boolean; noHeader?: boolean } = {}) =>
    view === "dm" ? (
      <DmSidebar activeDm={activeDm} onPickDm={enterDm} onShowFriends={() => setActiveDm(null)} {...opts} />
    ) : (
      <ChannelSidebar {...channelProps} {...opts} />
    )

  // The whole content column (header + body). Branches: open thread → thread takeover;
  // @me view → DM conversation or Friends page; server view → channel + right panel.
  const contentColumn = ({ compact, hamburger }: { compact?: boolean; hamburger?: boolean } = {}) => {
    if (openThread)
      return (
        <>
          <ThreadHeader thread={openThread} channelName={activeChannel} forum={isForum} onClose={() => setOpenThreadId(null)} onBack={compact ? () => setMobileZone("channels") : undefined} />
          <main className="flex min-h-0 flex-1 flex-col">
            <ThreadMessages thread={openThread} {...profileProps} />
            <Composer channel={openThread.name} thread />
          </main>
        </>
      )

    if (view === "dm")
      return dm ? (
        <>
          <DmHeader dm={dm} onBack={compact ? () => setMobileZone("channels") : undefined} />
          <main className="flex min-h-0 flex-1 flex-col">
            <DmMessages dm={dm} {...profileProps} />
            <Composer channel={dm.name} thread />
          </main>
        </>
      ) : (
        <FriendsPage onBack={compact ? () => setMobileZone("channels") : undefined} hamburger={hamburger ? () => setSidebarOpen(true) : undefined} {...profileProps} />
      )

    // forum channel → post list (a forum is a feed of threads, not a chat)
    if (isForum)
      return (
        <ForumView
          channel={activeChannel}
          posts={FORUM_POSTS[activeChannel] ?? []}
          onOpenPost={enterThread}
          onHamburger={hamburger ? () => setSidebarOpen(true) : undefined}
          onBack={compact ? () => setMobileZone("channels") : undefined}
        />
      )

    return (
      <>
        <ChannelHeader
          channel={activeChannel}
          rightPanel={rightPanel}
          onToggle={togglePanel}
          searchBox={!compact && bp === "desktop"}
          onHamburger={hamburger ? () => setSidebarOpen(true) : undefined}
          onBack={compact ? () => setMobileZone("channels") : undefined}
        />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <MessageList channel={activeChannel} onOpenThread={enterThread} {...profileProps} />
            <Composer channel={activeChannel} />
          </main>
          {/* desktop renders the panel inline; tablet/mobile use overlays below */}
          {bp === "desktop" && rightPanel && (
            <aside className={`${rightPanel === "members" ? "w-60" : "w-80"} shrink-0 border-l border-border`}>
              <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} {...panelProps} {...profileProps} />
            </aside>
          )}
        </div>
      </>
    )
  }

  // ── Settings — full-screen view replacing the whole shell (Discord behavior) ──
  if (view === "settings") {
    return (
      <Shell>
        <ServerSettings section={settingsSection} setSection={setSettingsSection} onClose={goServer} {...profileProps} />
        {profile && <ProfileCard data={PROFILES[profile.name]} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} />}
      </Shell>
    )
  }

  // ── Desktop: full 4-column resizable shell ──
  if (bp === "desktop") {
    return (
      <Shell>
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="24%" minSize="20%" maxSize="36%" className="flex flex-col" style={{ background: "var(--d-rail)" }}>
            <div className="flex min-h-0 flex-1">
              <ServerRail {...railProps} />
              {sidebar({ bordered: true })}
            </div>
            <UserBar mounted={mounted} {...profileProps} />
          </ResizablePanel>

          <ResizableHandle className="bg-transparent" />

          <ResizablePanel defaultSize="76%" className="flex min-w-0 flex-col border-t border-r border-border bg-sidebar">
            {contentColumn()}
          </ResizablePanel>
        </ResizablePanelGroup>
        {profile && <ProfileCard data={PROFILES[profile.name]} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} />}
      </Shell>
    )
  }

  // ── Tablet: rail + messages, sidebar & right panel as scrim overlays ──
  if (bp === "tablet") {
    return (
      <Shell>
        <div className="flex min-h-0 flex-1" style={{ background: "var(--d-rail)" }}>
          <ServerRail {...railProps} />
          <div className="flex min-w-0 flex-1 flex-col rounded-tl-xl border-l border-t border-r border-border bg-sidebar">
            {contentColumn({ hamburger: true })}
          </div>
        </div>

        {/* left overlay: channel / DM sidebar */}
        {sidebarOpen && (
          <Overlay onClose={() => setSidebarOpen(false)} side="left">
            <div className="flex h-full w-70 flex-col" style={{ background: "var(--d-rail)" }}>
              <div className="flex min-h-0 flex-1">
                {sidebar()}
              </div>
              <UserBar mounted={mounted} {...profileProps} />
            </div>
          </Overlay>
        )}

        {/* right overlay: members / pinned / search / thread */}
        {rightPanel && view === "server" && !openThread && (
          <Overlay onClose={() => setRightPanel(null)} side="right">
            <div className="h-full w-[320px] bg-background shadow-(--e2)">
              <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} {...profileProps} />
            </div>
          </Overlay>
        )}
        {profile && <ProfileCard data={PROFILES[profile.name]} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} />}
      </Shell>
    )
  }

  // ── Mobile: single-zone stack navigation ──
  return (
    <Shell>
      {mobileZone === "rail" && (
        <MobileRail onPick={() => setMobileZone("channels")} onHome={goHome} onServer={goServer} view={view} />
      )}

      {mobileZone === "channels" && (
        <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--d-rail)" }}>
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileZone("rail")} className="text-muted-foreground hover:text-foreground" aria-label="Back to servers"><ChevronLeft className="size-5" /></Button>
            <span className="ml-1 truncate text-base font-semibold">{view === "dm" ? "Direct Messages" : "Alook"}</span>
          </header>
          <div className="flex min-h-0 flex-1">
            {sidebar({ noHeader: true })}
          </div>
          <UserBar mounted={mounted} {...profileProps} />
        </div>
      )}

      {mobileZone === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col bg-sidebar">
          {contentColumn({ compact: true })}
        </div>
      )}

      {/* full-screen panel overlay */}
      {rightPanel && view === "server" && !openThread && (
        <div className="absolute inset-0 z-20 bg-background">
          <RightPanelContent kind={rightPanel} onClose={() => setRightPanel(null)} showClose {...panelProps} {...profileProps} />
        </div>
      )}
      {profile && <ProfileCard data={PROFILES[profile.name]} x={profile.x} y={profile.y} bp={bp} onClose={() => setProfile(null)} />}
    </Shell>
  )
}

// ── Shell + window bar ────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden font-sans text-[15px] text-foreground [--d-rail:oklch(0.95_0.006_80)] dark:[--d-rail:oklch(0.13_0.008_60)]">
      <header className="flex h-8 shrink-0 items-center justify-center px-3" style={{ background: "var(--d-rail)" }}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <span className="grid size-4 place-items-center rounded-sm bg-primary text-[10px] font-semibold text-primary-foreground">A</span>
          Alook
        </div>
        <div className="absolute right-3 flex items-center gap-3 text-muted-foreground">
          <Popover>
            <PopoverTrigger
              render={
                <button className="relative hover:text-foreground aria-expanded:text-foreground" aria-label="Inbox" />
              }
            >
              <Inbox className="size-4.5" />
              {MENTIONS.length > 0 && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary" />}
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0">
              <InboxPopover />
            </PopoverContent>
          </Popover>
          <span className="grid size-4.5 place-items-center rounded-full border border-current text-[11px]">?</span>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">{children}</div>
    </div>
  )
}

// ── Scrim overlay (tablet) ────────────────────────────────────────────────
function Overlay({ children, onClose, side }: { children: React.ReactNode; onClose: () => void; side: "left" | "right" }) {
  return (
    <div className="absolute inset-0 z-20 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-foreground/20" />
      <div className={`relative h-full ${side === "right" ? "ml-auto" : ""}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

// ── Server rail (72px) ────────────────────────────────────────────────────
const FOLDER_ID = "folder"

function ServerRail({ setMobileZone, view, onHome, onServer }: { setMobileZone?: (z: MobileZone) => void; view: View; onHome: () => void; onServer: () => void }) {
  // unified rail order — server ids plus the folder placeholder, all sortable together
  const [order, setOrder] = useState<string[]>([...SERVERS.map((s) => s.id), FOLDER_ID])
  const [activeId, setActiveId] = useState(SERVERS.find((s) => s.active)?.id ?? SERVERS[0].id)
  const [folderOpen, setFolderOpen] = useState(false)
  const [reopenAfterDrag, setReopenAfterDrag] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // dragging the folder auto-collapses it; it reopens once the drag settles
  const onDragStart = (e: DragStartEvent) => {
    if (e.active.id === FOLDER_ID && folderOpen) {
      setReopenAfterDrag(true)
      setFolderOpen(false)
    }
  }
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id) {
      setOrder((prev) => {
        const from = prev.indexOf(String(active.id))
        const to = prev.indexOf(String(over.id))
        if (from === -1 || to === -1) return prev
        return arrayMove(prev, from, to)
      })
    }
    if (reopenAfterDrag) { setFolderOpen(true); setReopenAfterDrag(false) }
  }
  // selecting a server: mark it active locally + switch into server view
  const pickServer = (id: string) => { setActiveId(id); onServer(); setMobileZone?.("channels") }
  const byId = (id: string) => SERVERS.find((s) => s.id === id)
  return (
    <nav className="flex w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-clip thin-scrollbar">
      {/* @me / Direct Messages home */}
      <RailIcon
        active={view === "dm"}
        onClick={onHome}
        tooltip="Direct Messages"
        label={
          <>
            <img src="/alook.svg" alt="Alook" className="size-6 dark:hidden" />
            <img src="/alook-dark.svg" alt="Alook" className="hidden size-6 dark:block" />
          </>
        }
        round
      />
      <div className="my-1 h-px w-8 bg-border" />
      <DndContext id="d-rail" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="flex w-full flex-col items-center gap-2">
            {order.map((id) => {
              if (id === FOLDER_ID)
                return (
                  <RailFolder
                    key={id}
                    open={folderOpen}
                    onToggle={() => setFolderOpen((v) => !v)}
                    activeId={activeId}
                    onSelect={pickServer}
                    setMobileZone={setMobileZone}
                  />
                )
              const s = byId(id)!
              return (
                <SortableServer
                  key={id}
                  server={s}
                  active={view !== "dm" && activeId === id}
                  onClick={() => pickServer(id)}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
      <RailIcon label={<Plus className="size-6" />} round accent tooltip="Add a Server" onClick={() => setCreateOpen(true)} />

      {createOpen && <CreateServerDialog onClose={() => setCreateOpen(false)} />}
    </nav>
  )
}

// rail icon hover tooltip — portaled to body with fixed positioning so it never
// widens the rail (a `left-full` absolute child would force horizontal overflow on
// the overflow-y-auto nav, enabling stray horizontal scroll/drag). Hover is bound to
// the parent icon element directly, so no overlay blocks its clicks or drag.
function RailTooltip({ label }: { label: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const parent = anchorRef.current?.parentElement
    if (!parent) return
    const show = () => {
      const r = parent.getBoundingClientRect()
      // anchor to the icon's visual center (40px) + 8px gap, not the 72px-wide parent's edge
      setPos({ x: r.left + r.width / 2 + 20 + 8, y: r.top + r.height / 2 })
    }
    const hide = () => setPos(null)
    parent.addEventListener("mouseenter", show)
    parent.addEventListener("mouseleave", hide)
    parent.addEventListener("pointerdown", hide) // drag/click dismisses it
    return () => {
      parent.removeEventListener("mouseenter", show)
      parent.removeEventListener("mouseleave", hide)
      parent.removeEventListener("pointerdown", hide)
    }
  }, [])
  return (
    <>
      <span ref={anchorRef} className="hidden" />
      {pos && createPortal(
        <span
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-sm font-medium text-popover-foreground shadow-(--e2)"
          style={{ left: pos.x, top: pos.y }}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  )
}

// left rail indicator — 3 states: active (40px), hover (20px), default (8px dot).
// Parent must be `group relative`.
function RailIndicator({ active }: { active?: boolean }) {
  return (
    <span
      className={[
        "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
        active ? "h-10" : "h-2 group-hover:h-5",
      ].join(" ")}
    />
  )
}

// drag-sortable server icon — handle-less (5px activation), tooltip, mention badge, drop line
function SortableServer({ server, active, onClick }: { server: typeof SERVERS[number]; active?: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: server.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div ref={setNodeRef} style={style} className="group relative flex w-full justify-center" />}
      >
        {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
        <RailIndicator active={active} />
        {/* icon wrapper sized to the icon so the badge anchors to its corner */}
        <div className="relative size-10">
          <button
            onClick={onClick}
            {...attributes}
            {...listeners}
            className={[
              "grid size-10 cursor-pointer touch-none place-items-center text-sm font-semibold transition-all duration-150 active:cursor-grabbing",
              active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-[18px] bg-card hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
            ].join(" ")}
          >
            {server.initial}
          </button>
          {server.mentions > 0 && (
            <span
              className="pointer-events-none absolute -bottom-1 -right-1 grid min-w-5 place-items-center rounded-full border-[3px] border-(--d-rail) px-1 text-[11px] font-bold leading-4.5 text-white"
              style={{ background: "oklch(0.62 0.21 25)" }}
            >
              {server.mentions}
            </span>
          )}
        </div>
        <RailTooltip label={server.name} />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{server.name}</div>
        <ContextMenuItem>Mark As Read</ContextMenuItem>
        <ContextMenuItem>Mute Server</ContextMenuItem>
        <ContextMenuItem>Notification Settings</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">Leave Server</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// create / join server dialog
function CreateServerDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<"choose" | "create" | "join">("choose")
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{step === "choose" ? "Create a Server" : step === "create" ? "Customize your server" : "Join a Server"}</DialogTitle>
        </DialogHeader>
        <div className="p-5">
          {step === "choose" && (
            <div className="space-y-2">
              <p className="mb-3 text-sm text-muted-foreground">Your server is where you and your agents hang out. Make yours and start talking.</p>
              <button onClick={() => setStep("create")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-5" /></span>
                <span className="flex-1 text-[15px] font-medium">Create My Own</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
              <button onClick={() => setStep("join")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-foreground"><Link2 className="size-5" /></span>
                <span className="flex-1 text-[15px] font-medium">Join a Server</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            </div>
          )}
          {step === "create" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2">
                <div className="grid size-20 place-items-center rounded-full border-2 border-dashed border-input text-muted-foreground"><Plus className="size-6" /></div>
                <span className="text-xs text-muted-foreground">Upload an icon</span>
              </div>
              <Field label="Server name"><Input defaultValue="Gener's server" /></Field>
            </div>
          )}
          {step === "join" && (
            <Field label="Invite link"><Input /></Field>
          )}
        </div>
        {step !== "choose" && (
          <DialogFooter className="mx-0 mb-0 flex-row items-center justify-between rounded-b-xl border-t border-border bg-card px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => setStep("choose")}>Back</Button>
            <Button size="sm" onClick={onClose}>{step === "create" ? "Create" : "Join Server"}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Server folder — collapsed shows a 2×2 mini-icon grid; clicking expands the group
// to reveal its member servers stacked below (Discord behavior).
const FOLDER_SERVERS = [
  { id: "fld_ai", initial: "AI", name: "Acontext" },
  { id: "fld_ml", initial: "ML", name: "memobase" },
  { id: "fld_js", initial: "JS", name: "Second Me" },
  { id: "fld_go", initial: "GO", name: "Midjourney" },
]

function RailFolder({ open, onToggle, activeId, onSelect, setMobileZone }: { open: boolean; onToggle: () => void; activeId: string; onSelect: (id: string) => void; setMobileZone?: (z: MobileZone) => void }) {
  const [items, setItems] = useState(FOLDER_SERVERS)
  // the folder icon is sortable within the rail's outer SortableContext
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: FOLDER_ID })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  // inner context reorders the member servers (only mounted while expanded)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onInnerDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems((prev) => {
      const from = prev.findIndex((s) => s.id === active.id)
      const to = prev.findIndex((s) => s.id === over.id)
      if (from === -1 || to === -1) return prev
      return arrayMove(prev, from, to)
    })
  }
  const pick = (id: string) => { onSelect(id); setMobileZone?.("channels") }
  return (
    <div ref={setNodeRef} style={style} className="flex w-full flex-col items-center gap-2">
      <div className="group relative flex w-full justify-center">
        {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
        {/* folder indicator is active when (collapsed and) one of its servers is selected */}
        <RailIndicator active={!open && items.some((s) => s.id === activeId)} />
        <button
          onClick={onToggle}
          {...attributes}
          {...listeners}
          className={[
            "grid size-10 cursor-pointer touch-none grid-cols-2 gap-0.5 p-1.5 transition-all duration-150 active:cursor-grabbing",
            open ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent hover:rounded-xl hover:bg-primary/20",
          ].join(" ")}
        >
          {FOLDER_SERVERS.map((s) => (
            <span key={s.id} className="grid place-items-center rounded-lg bg-card text-[7px] font-semibold text-muted-foreground">{s.initial}</span>
          ))}
        </button>
        <RailTooltip label="Workspaces" />
      </div>
      {/* expanded: member servers full-width (so their left bars align with the rail
          edge like other servers); the tinted pill background sits behind, centered */}
      {open && (
        <div className="relative flex w-full flex-col items-center gap-2 py-2">
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-12 -translate-x-1/2 rounded-[20px] bg-primary/10" />
          <DndContext id="d-folder" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onInnerDragEnd}>
            <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {items.map((s) => (
                <SortableFolderServer key={s.id} server={s} active={activeId === s.id} onClick={() => pick(s.id)} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  )
}

// a draggable server inside an expanded folder
function SortableFolderServer({ server, active, onClick }: { server: typeof FOLDER_SERVERS[number]; active: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: server.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <div ref={setNodeRef} style={style} className="group relative flex w-full justify-center">
      {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
      <RailIndicator active={active} />
      <button
        onClick={onClick}
        {...attributes}
        {...listeners}
        className={[
          "grid size-10 cursor-pointer touch-none place-items-center text-sm font-semibold transition-all duration-150 active:cursor-grabbing",
          active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-[18px] bg-card hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
        ].join(" ")}
      >
        {server.initial}
      </button>
      <RailTooltip label={server.name} />
    </div>
  )
}

// ── Mobile rail zone — full-width server list with names ──
function MobileRail({ onPick, onHome, onServer, view }: { onPick: () => void; onHome: () => void; onServer: () => void; view: View }) {
  const [folderOpen, setFolderOpen] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto thin-scrollbar p-3" style={{ background: "var(--d-rail)" }}>
      <button onClick={onHome} className={`mb-1 flex items-center gap-3 rounded-lg p-2 ${view === "dm" ? "bg-accent" : "hover:bg-accent"}`}>
        <span className="grid size-10 shrink-0 place-items-center rounded-[18px] bg-card">
          <img src="/alook.svg" alt="" className="size-6 dark:hidden" />
          <img src="/alook-dark.svg" alt="" className="hidden size-6 dark:block" />
        </span>
        <span className="text-sm font-medium text-muted-foreground">Direct Messages</span>
      </button>
      <div className="my-2 h-px w-full bg-border" />
      {SERVERS.map((s) => (
        <button key={s.id} onClick={() => { onServer(); onPick() }} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
          <span className={[
            "grid size-10 shrink-0 place-items-center rounded-[18px] text-sm font-semibold",
            view !== "dm" && s.active ? "bg-primary text-primary-foreground" : "bg-card",
          ].join(" ")}>{s.initial}</span>
          <span className="flex-1 text-left text-[15px] font-medium">{s.name}</span>
          {s.unread && <span className="size-2 rounded-full bg-primary" />}
        </button>
      ))}

      {/* server folder — tap to expand its member servers */}
      <button onClick={() => setFolderOpen((v) => !v)} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
        <span className={`grid size-10 shrink-0 grid-cols-2 gap-0.5 p-1.5 ${folderOpen ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent"}`}>
          {FOLDER_SERVERS.map((s) => (
            <span key={s.id} className="grid place-items-center rounded-lg bg-card text-[7px] font-semibold text-muted-foreground">{s.initial}</span>
          ))}
        </span>
        <span className="flex-1 text-left text-[15px] font-medium">Workspaces</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${folderOpen ? "" : "-rotate-90"}`} />
      </button>
      {folderOpen && (
        <div className="ml-3 flex flex-col gap-1 border-l border-border pl-3">
          {FOLDER_SERVERS.map((s) => (
            <button key={s.id} onClick={() => { onServer(); onPick() }} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
              <span className="grid size-10 shrink-0 place-items-center rounded-[18px] bg-card text-sm font-semibold">{s.initial}</span>
              <span className="flex-1 text-left text-[15px] font-medium">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      <button className="mt-1 flex items-center gap-3 rounded-lg p-2 text-primary hover:bg-accent">
        <span className="grid size-10 shrink-0 place-items-center rounded-[18px] bg-card"><Plus className="size-6" /></span>
        <span className="text-[15px] font-medium">Add a Server</span>
      </button>
    </div>
  )
}

// ── Channel sidebar ────────────────────────────────────────────────────────
function ChannelSidebar({
  activeChannel, setActiveChannel, bordered, noHeader, onOpenSettings,
}: {
  activeChannel: string
  setActiveChannel: (id: string) => void
  bordered?: boolean
  noHeader?: boolean
  onOpenSettings?: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // category order + per-category channel order (CATEGORIES is a const; dnd edits this copy)
  const [catOrder, setCatOrder] = useState<string[]>(() => CATEGORIES.map((c) => c.name))
  const [order, setOrder] = useState<Record<string, Channel[]>>(() =>
    Object.fromEntries(CATEGORIES.map((c) => [c.name, c.channels])),
  )
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const toggleCat = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })

  // ids are prefixed: "cat:<name>" for a category, bare id for a channel
  const isCat = (id: string) => id.startsWith("cat:")
  // which category currently holds a channel id (a category drop target is "cat:<name>")
  const catOf = (id: string, o: Record<string, Channel[]>) => {
    if (isCat(id)) return id.slice(4)
    return Object.keys(o).find((cat) => o[cat].some((c) => c.id === id))
  }

  // live cross-category move while dragging a channel (Discord lets channels jump categories)
  const onDragOver = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || isCat(String(active.id))) return // category drags handled on drop
    setOrder((prev) => {
      const fromCat = catOf(String(active.id), prev)
      const toCat = catOf(String(over.id), prev)
      if (!fromCat || !toCat || fromCat === toCat) return prev
      const moving = prev[fromCat].find((c) => c.id === active.id)
      if (!moving) return prev
      const overIdx = prev[toCat].findIndex((c) => c.id === over.id)
      const insertAt = overIdx === -1 ? prev[toCat].length : overIdx
      const nextTo = [...prev[toCat]]
      nextTo.splice(insertAt, 0, moving)
      return {
        ...prev,
        [fromCat]: prev[fromCat].filter((c) => c.id !== active.id),
        [toCat]: nextTo,
      }
    })
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    // category drag → reorder categories (channels ride along since they live in `order`)
    if (isCat(String(active.id)) && isCat(String(over.id))) {
      setCatOrder((prev) => {
        const from = prev.indexOf(String(active.id).slice(4))
        const to = prev.indexOf(String(over.id).slice(4))
        if (from === -1 || to === -1) return prev
        return arrayMove(prev, from, to)
      })
      return
    }
    if (isCat(String(active.id))) return
    // channel drag → settle order within the destination category
    setOrder((prev) => {
      const cat = catOf(String(active.id), prev)
      if (!cat || !prev[cat].some((c) => c.id === over.id)) return prev
      const from = prev[cat].findIndex((c) => c.id === active.id)
      const to = prev[cat].findIndex((c) => c.id === over.id)
      if (from === -1 || to === -1) return prev
      return { ...prev, [cat]: arrayMove(prev[cat], from, to) }
    })
  }

  return (
    <aside className={`flex min-w-0 flex-1 flex-col ${bordered ? "rounded-tl-xl border-l border-t border-border" : ""}`}>
      {!noHeader && (
        <header className="flex h-12 items-center justify-between gap-2 border-b border-border px-4">
          <span className="truncate text-base font-semibold">Alook</span>
          <button onClick={onOpenSettings} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Server settings">
            <Settings className="size-4" />
          </button>
        </header>
      )}
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-3">
        {/* one DndContext spans everything: categories sort among themselves, channels across categories */}
        <DndContext id="d-channels" sensors={sensors} collisionDetection={closestCenter} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <SortableContext items={catOrder.map((n) => `cat:${n}`)} strategy={verticalListSortingStrategy}>
            {catOrder.map((name) => (
              <SortableCategory key={name} name={name} open={!collapsed.has(name)} onToggle={() => toggleCat(name)}>
                <SortableContext items={order[name].map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  <div className="mt-0.5 min-h-2 space-y-0.5">
                    {order[name].map((ch) => (
                      <SortableChannel key={ch.id} ch={ch} active={ch.id === activeChannel} onClick={() => setActiveChannel(ch.id)} />
                    ))}
                  </div>
                </SortableContext>
              </SortableCategory>
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </aside>
  )
}

// drop-target line shown at the insertion point while dragging (Discord behavior)
function DropLine({ side }: { side: "top" | "bottom" }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${side === "top" ? "-top-px" : "-bottom-px"}`}
    />
  )
}

// A drag-sortable category. The whole header is the drag surface (no handle) — a 5px
// activation distance distinguishes a click (collapse) from a drag. It is also a drop
// target so channels can be dropped onto it (including its empty space).
function SortableCategory({ name, open, onToggle, children }: { name: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: `cat:${name}` })
  const { setNodeRef: setDropRef, isOver: isChannelOver } = useDroppable({ id: `cat:${name}` })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <div ref={setNodeRef} style={style} className="relative mb-4">
      {showLine && <DropLine side={lineSide} />}
      <div
        {...attributes}
        {...listeners}
        onClick={onToggle}
        className="group flex w-full cursor-grab touch-none items-center gap-0.5 rounded px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="flex-1 text-left">{name}</span>
        <Plus className="size-3.5 opacity-0 group-hover:opacity-100" />
      </div>
      {open && (
        <div ref={setDropRef} className={`rounded-md transition-colors ${isChannelOver ? "bg-accent/40" : ""}`}>
          {children}
        </div>
      )}
    </div>
  )
}

// A single drag-sortable channel row. The whole row is the drag surface (no handle);
// a 5px activation distance keeps a tap = "switch channel" and a drag = reorder.
function SortableChannel({ ch, active, onClick }: { ch: Channel; active: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: ch.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      {...attributes}
      {...listeners}
      className={[
        "group relative flex h-8 w-full cursor-pointer touch-none items-center gap-1.5 rounded-md px-2 text-[15px] active:cursor-grabbing",
        active
          ? "bg-accent text-foreground"
          : ch.muted
            ? "text-muted-foreground/50 hover:bg-accent/60 hover:text-muted-foreground"
            : ch.unread
              ? "text-foreground hover:bg-accent/60"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      ].join(" ")}
    >
      {showLine && <DropLine side={lineSide} />}
      {ch.type === "forum" ? (
        <MessagesSquare className="size-5 shrink-0 opacity-70" />
      ) : (
        <Hash className="size-5 shrink-0 opacity-70" />
      )}
      <span className="truncate">{ch.name}</span>
      {ch.muted ? (
        <BellOff className="ml-auto size-4 shrink-0 opacity-70" />
      ) : ch.unread && !active ? (
        <span className="ml-auto size-2 rounded-full bg-primary" />
      ) : null}
    </div>
  )
}

// ── User bar ───────────────────────────────────────────────────────────────
function UserBar({ mounted, onOpenProfile }: { mounted: boolean; onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <div className="shrink-0 px-2 pb-2 pt-0">
      <div className="flex h-14 items-center gap-3 rounded-lg bg-secondary p-4">
        <button onClick={(e) => onOpenProfile?.("Gener", e)} className="relative shrink-0">
          <Avatar label="G" size={32} />
          <PresenceDot status="online" />
        </button>
        <button onClick={(e) => onOpenProfile?.("Gener", e)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium leading-tight">Gener</div>
          <div className="truncate text-xs leading-tight text-muted-foreground">Online</div>
        </button>
        <button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Toggle theme"
        >
          {mounted && (resolvedTheme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />)}
        </button>
      </div>
    </div>
  )
}

// ── Channel header ───────────────────────────────────────────────────────
function ChannelHeader({
  channel, rightPanel, onToggle, onHamburger, onBack, searchBox,
}: {
  channel: string
  rightPanel: RightPanel
  onToggle: (k: Exclude<RightPanel, null>) => void
  onHamburger?: () => void
  onBack?: () => void
  searchBox?: boolean
}) {
  const tool = (k: Exclude<RightPanel, null>, Icon: typeof Hash, label: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => onToggle(k)}
      aria-label={label}
      className={`text-muted-foreground hover:text-foreground ${rightPanel === k ? "bg-accent text-foreground" : ""}`}
    >
      <Icon className="size-5" />
    </Button>
  )
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      {onHamburger && (
        <Button variant="ghost" size="icon-sm" onClick={onHamburger} className="text-muted-foreground hover:text-foreground" aria-label="Open channels"><Menu className="size-5" /></Button>
      )}
      <Hash className="ml-1 size-6 text-muted-foreground" />
      <h1 className="truncate text-base font-medium">{channel}</h1>
      <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
        {tool("threads", MessagesSquare, "Threads")}
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Notifications"><Bell className="size-5" /></Button>
        {tool("pinned", Pin, "Pinned messages")}
        {tool("members", Users, "Member list")}
        {/* On desktop the search box replaces the icon; tablet/mobile keep the icon */}
        {!searchBox && tool("search", Search, "Search")}
      </div>
      {searchBox && (
        <Button
          variant="secondary"
          onClick={() => onToggle("search")}
          className="ml-2 h-8 w-60 shrink-0 justify-between font-normal text-muted-foreground hover:text-foreground"
        >
          Search <Search className="size-4" />
        </Button>
      )}
    </header>
  )
}

// ── Message list ─────────────────────────────────────────────────────────
function MessageList({ channel, onOpenThread, onOpenProfile }: { channel: string; onOpenThread: (id: string) => void; onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  // bulk-select mode, jump highlight (context menu now lives per-Message)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [jumped, setJumped] = useState<string | null>(null)

  const startSelect = (id: string) => { setSelectMode(true); toggleSel(id) }
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  // jump-to-message: scroll into view + pulse highlight (reuses the .task-highlight idea)
  const jumpTo = (id: string) => {
    setJumped(id)
    document.getElementById(`dpv-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    window.setTimeout(() => setJumped((v) => (v === id ? null : v)), 1600)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto thin-scrollbar">
        <div className="flex min-h-full flex-col justify-end gap-4 px-4 py-5">
          <div className="mb-2">
            <div className="mb-3 grid size-17 place-items-center rounded-full bg-muted">
              <Hash className="size-9 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-semibold leading-tight">Welcome to #{channel}</h2>
            <p className="mt-1 text-sm text-muted-foreground">This is the start of the channel.</p>
          </div>

          <DateDivider label="May 11, 2026" />

          {MESSAGES.map((m) => (
            <div key={m.id}>
              {m.id === NEW_DIVIDER_BEFORE && <NewDivider />}
              <Message
                m={m}
                onOpenThread={onOpenThread}
                onOpenProfile={onOpenProfile}
                onStartSelect={() => startSelect(m.id)}
                onJumpReply={() => jumpTo("m3")}
                selectMode={selectMode}
                selected={selected.has(m.id)}
                onToggleSelect={() => toggleSel(m.id)}
                highlighted={jumped === m.id}
              />
            </div>
          ))}

          <TypingIndicator />
        </div>
      </div>

      {/* bulk-select bar */}
      {selectMode && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border bg-background px-4">
          <span className="text-sm text-muted-foreground">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setSelectMode(false); setSelected(new Set()) }}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={selected.size === 0}>
              <Trash2 className="size-4" /> Delete {selected.size || ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function NewDivider() {
  return (
    <div className="my-1 flex items-center gap-2">
      <div className="h-px flex-1 bg-destructive/60" />
      <span className="rounded-sm bg-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive-foreground">New</span>
    </div>
  )
}

// shared message-action items, rendered for either ContextMenu or DropdownMenu
function messageMenuItems(onStartSelect: () => void) {
  return [
    { label: "Add Reaction", icon: SmilePlus },
    { label: "Reply", icon: Reply },
    { label: "Edit", icon: Pencil },
    { label: "Pin Message", icon: Pin },
    { label: "Select Messages", icon: CheckSquare, onClick: onStartSelect },
    { label: "Copy Text", icon: Copy },
    { label: "sep" as const },
    { label: "Delete", icon: Trash2, danger: true },
  ]
}

function MessageContextItems({ onStartSelect }: { onStartSelect: () => void }) {
  return (
    <>
      {messageMenuItems(onStartSelect).map((it, i) =>
        it.label === "sep" ? (
          <ContextMenuSeparator key={i} />
        ) : (
          <ContextMenuItem key={it.label} onClick={it.onClick} className={it.danger ? "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive" : ""}>
            {it.icon && <it.icon className="size-4" />} {it.label}
          </ContextMenuItem>
        ),
      )}
    </>
  )
}

function MessageDropdownItems({ onStartSelect }: { onStartSelect: () => void }) {
  return (
    <>
      {messageMenuItems(onStartSelect).map((it, i) =>
        it.label === "sep" ? (
          <DropdownMenuSeparator key={i} />
        ) : (
          <DropdownMenuItem key={it.label} onClick={it.onClick} variant={it.danger ? "destructive" : "default"}>
            {it.icon && <it.icon className="size-4" />} {it.label}
          </DropdownMenuItem>
        ),
      )}
    </>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      <span><span className="font-medium text-foreground">Lindsay</span> is typing…</span>
    </div>
  )
}

// ── Composer ───────────────────────────────────────────────────────────────

// emoji-mart picker — themed to match light/dark. Uses the native set so it
// renders system emoji without fetching an external SVG sprite (the twitter/twemoji
// set shows "#" placeholders when the CDN sprite can't load).
function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { resolvedTheme } = useTheme()
  return (
    <EmojiMartPicker
      data={emojiMartData}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      set="native"
      previewPosition="none"
      skinTonePosition="none"
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
    />
  )
}

// emoji picker in a shadcn Popover — trigger is the passed child, picker portals out
function EmojiPickerPopover({ children, onPick, side = "top", align = "end", onOpenChange }: { children: React.ReactNode; onPick: (emoji: string) => void; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const setBoth = (o: boolean) => { setOpen(o); onOpenChange?.(o) }
  return (
    <Popover open={open} onOpenChange={setBoth}>
      <PopoverTrigger render={children as React.ReactElement} />
      <PopoverContent side={side} align={align} className="w-auto border-none bg-transparent p-0 shadow-none">
        <EmojiPicker onPick={(e) => { onPick(e); setBoth(false) }} />
      </PopoverContent>
    </Popover>
  )
}

function Composer({ channel, thread }: { channel: string; thread?: boolean }) {
  const [value, setValue] = useState("")
  // @mention autocomplete: open when the trailing token starts with "@"
  const mentionQuery = (() => {
    const m = value.match(/@(\w*)$/)
    return m ? m[1].toLowerCase() : null
  })()
  const mentionMatches = mentionQuery !== null
    ? FRIENDS.filter((f) => f.name.toLowerCase().includes(mentionQuery)).slice(0, 5)
    : []

  const send = () => {
    if (!value.trim()) return
    setValue("")
  }
  const pickMention = (name: string) => setValue((v) => v.replace(/@\w*$/, `@${name} `))

  return (
    <div className="relative px-2 pb-2 pt-0">
      {/* @mention autocomplete — floats above the input */}
      {mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-lg border border-border bg-popover shadow-(--e2)">
          <div className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</div>
          {mentionMatches.map((f) => (
            <button key={f.id} onClick={() => pickMention(f.name)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent">
              <div className="relative shrink-0"><Avatar label={f.avatar} size={24} /><PresenceDot status={f.status} /></div>
              <span className="text-sm font-medium">{f.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex h-14 items-center gap-3 rounded-lg bg-secondary p-4">
        <PlusCircle className="size-5 shrink-0 text-muted-foreground" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send() } }}
          className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          placeholder={thread ? `Message ${channel}` : `Message #${channel}`}
        />
        <EmojiPickerPopover side="top" align="end" onPick={(e) => setValue((v) => v + e)}>
          <button className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
            <Smile className="size-5" />
          </button>
        </EmojiPickerPopover>
      </div>
    </div>
  )
}

// ── Right panel content (members / pinned / search / threads) ───────────────
function RightPanelContent({
  kind, onClose, showClose, onOpenThread, onOpenProfile,
}: {
  kind: Exclude<RightPanel, null>
  onClose: () => void
  showClose?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: (name: string, e: React.MouseEvent) => void
}) {
  if (kind === "members")
    // Desktop shows the bare list under the spanning channel header (no own header).
    // Overlay contexts (tablet/mobile) wrap it so it gets a dismiss bar.
    return showClose ? (
      <PanelShell icon={Users} title="Members" onClose={onClose} showClose bodyClassName="p-0">
        <MemberList onOpenProfile={onOpenProfile} />
      </PanelShell>
    ) : (
      <MemberList onOpenProfile={onOpenProfile} />
    )
  if (kind === "pinned")
    return (
      <PanelShell icon={Pin} title="Pinned Messages" onClose={onClose} showClose={showClose}>
        {PINNED.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} compact onOpenThread={() => {}} onOpenProfile={onOpenProfile} />)}
      </PanelShell>
    )
  if (kind === "search")
    return (
      <PanelShell icon={Search} title="Search" onClose={onClose} showClose={showClose}>
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 pl-8" placeholder="Search messages" />
        </div>
        <div className="mb-2 text-xs text-muted-foreground">2 results</div>
        {SEARCH_RESULTS.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} compact onOpenThread={() => {}} onOpenProfile={onOpenProfile} />)}
      </PanelShell>
    )
  // threads — channel thread list. Picking one opens it in the message area.
  return (
    <PanelShell icon={MessagesSquare} title="Threads" onClose={onClose} showClose={showClose}>
      <div className="mb-2 text-xs text-muted-foreground">{THREADS.length} threads</div>
      <div className="space-y-1">
        {THREADS.map((t) => (
          <button
            key={t.id}
            onClick={() => onOpenThread(t.id)}
            className="flex w-full items-start gap-2 rounded-md border border-border bg-card p-2.5 text-left hover:bg-accent"
          >
            <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium">{t.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{t.parent.author}</span> {t.parent.text}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t.count} messages · {t.lastActive}</div>
            </div>
          </button>
        ))}
      </div>
    </PanelShell>
  )
}

// ── Thread area (takes over the message area like a channel) ────────────────
function ThreadHeader({ thread, channelName = "welcome", forum, onClose, onBack }: { thread: Thread; channelName?: string; forum?: boolean; onClose: () => void; onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      {/* breadcrumb: # channel › 🧵 thread — clicking the channel returns to it */}
      <Button variant="ghost" size="sm" onClick={onClose} className="-mr-1 gap-1.5 px-1.5 text-base font-medium text-muted-foreground hover:text-foreground">
        {forum ? <MessagesSquare className="size-5" /> : <Hash className="size-5" />}
        {channelName}
      </Button>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      <MessagesSquare className="size-5 shrink-0 text-muted-foreground" />
      <h1 className="truncate text-base font-medium">{thread.name}</h1>
      <Button variant="ghost" size="icon-sm" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close thread"><X className="size-5" /></Button>
    </header>
  )
}

function ThreadMessages({ thread, onOpenProfile }: { thread: Thread; onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  return (
    <div className="flex-1 overflow-y-auto thin-scrollbar">
      <div className="flex min-h-full flex-col justify-end gap-4 px-4 py-5">
        {/* thread hero — mirrors the channel welcome */}
        <div className="mb-2">
          <div className="mb-3 grid size-17 place-items-center rounded-full bg-muted">
            <MessagesSquare className="size-8 text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-semibold leading-tight">{thread.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Started by <span className="font-medium text-foreground">{thread.parent.author}</span>
          </p>
        </div>

        <DateDivider label="May 11, 2026" />

        {thread.messages.map((m) => (
          <Message key={m.id} m={m} onOpenThread={() => {}} onOpenProfile={onOpenProfile} />
        ))}
      </div>
    </div>
  )
}

// ── Forum channel view — a feed of posts; each post opens as a thread ────────
function ForumView({
  channel, posts, onOpenPost, onHamburger, onBack,
}: {
  channel: string
  posts: ForumPost[]
  onOpenPost: (id: string) => void
  onHamburger?: () => void
  onBack?: () => void
}) {
  const [tag, setTag] = useState("All")
  const filtered = tag === "All" ? posts : posts.filter((p) => p.tags.includes(tag))
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
        )}
        {onHamburger && (
          <Button variant="ghost" size="icon-sm" onClick={onHamburger} className="text-muted-foreground hover:text-foreground" aria-label="Open channels"><Menu className="size-5" /></Button>
        )}
        <MessagesSquare className="ml-1 size-6 text-muted-foreground" />
        <h1 className="truncate text-base font-medium">{channel}</h1>
        <Button size="sm" className="ml-auto"><Plus className="size-4" /> New Post</Button>
      </header>

      {/* tag filter chips */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto thin-scrollbar border-b border-border px-3 py-2">
        {FORUM_TAGS.map((t) => (
          <Badge
            key={t}
            variant={tag === t ? "default" : "secondary"}
            className="shrink-0 cursor-pointer"
            render={<button onClick={() => setTag(t)} />}
          >
            {t === "All" ? t : `#${t}`}
          </Badge>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto thin-scrollbar p-4">
        {filtered.length === 0 ? (
          <EmptyState icon={MessagesSquare} label="No posts with this tag yet. Start one with New Post." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenPost(p.id)}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="flex items-center gap-2">
                  <Avatar label={p.avatar} size={24} />
                  <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{p.parent.author}</span> · {p.lastActive}
                  </span>
                </div>
                <h3 className="text-[15px] font-semibold leading-tight">{p.name}</h3>
                <p className="line-clamp-2 text-sm text-muted-foreground">{p.preview}</p>
                <div className="flex items-center gap-2">
                  {p.tags.map((t) => (
                    <Badge key={t} variant="secondary">#{t}</Badge>
                  ))}
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <MessagesSquare className="size-3.5" /> {p.count}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </>
  )
}

function PanelShell({ icon: Icon, title, onClose, showClose, children, bodyClassName = "p-3", onBack }: { icon: typeof Pin; title: string; onClose: () => void; showClose?: boolean; children: React.ReactNode; bodyClassName?: string; onBack?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {onBack ? (
          <button onClick={onBack} className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Back to threads">
            <ChevronLeft className="size-5" />
          </button>
        ) : (
          <Icon className="size-5 text-muted-foreground" />
        )}
        <h2 className="flex-1 truncate text-lg font-semibold">{title}</h2>
        {showClose && (
          <button onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close panel">
            <X className="size-4" />
          </button>
        )}
      </header>
      <div className={`flex-1 overflow-y-auto thin-scrollbar ${bodyClassName}`}>{children}</div>
    </div>
  )
}

function MemberList({ onOpenProfile }: { onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  return (
    <aside className="flex h-full flex-col overflow-y-auto thin-scrollbar bg-background">
      <div className="px-3 py-4">
        {Object.entries(MEMBERS).map(([group, list]) => (
          <div key={group} className="mb-4">
            <h3 className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group} — {list.length}
            </h3>
            {list.map((mem) => (
              <button
                key={mem.name}
                onClick={(e) => onOpenProfile?.(mem.name, e)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                style={{ opacity: mem.status === "offline" ? 0.4 : 1 }}
              >
                <div className="relative">
                  <Avatar label={mem.avatar} size={32} />
                  <PresenceDot status={mem.status} />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[15px] leading-tight">{mem.name}</div>
                  {mem.sub && (
                    <div className="truncate text-xs leading-tight text-muted-foreground">{mem.sub}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

// ── Rail items ──────────────────────────────────────────────────────────
function RailIcon({ label, round, accent, active, onClick, tooltip }: { label: React.ReactNode; round?: boolean; accent?: boolean; active?: boolean; onClick?: () => void; tooltip?: string }) {
  return (
    <div className="group relative flex w-full justify-center">
      {active !== undefined && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full bg-primary transition-all"
          style={{ width: 4, height: active ? 40 : 0 }}
        />
      )}
      <button
        onClick={onClick}
        className={[
          "group grid size-10 shrink-0 place-items-center transition-all duration-150",
          active ? "rounded-xl bg-primary text-primary-foreground" : round ? "rounded-[18px] hover:rounded-xl" : "rounded-xl",
          active ? "" : accent ? "bg-card text-primary" : "bg-card text-foreground",
          active ? "" : "hover:bg-primary hover:text-primary-foreground",
        ].join(" ")}
      >
        {label}
      </button>
      {tooltip && <RailTooltip label={tooltip} />}
    </div>
  )
}

// ── Message ─────────────────────────────────────────────────────────────
function DateDivider({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function Message({
  m, compact, onOpenThread, onOpenProfile, onStartSelect, onJumpReply,
  selectMode, selected, onToggleSelect, highlighted,
}: {
  m: Msg
  compact?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: (name: string, e: React.MouseEvent) => void
  onStartSelect?: () => void
  onJumpReply?: () => void
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  highlighted?: boolean
}) {
  // keep the hover toolbar pinned open while its ⋯ dropdown is open
  const [toolbarOpen, setToolbarOpen] = useState(false)

  if (m.type === "system") {
    const Icon = m.systemKind === "thread" ? MessagesSquare : UserPlus
    return (
      <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
        <Icon className="size-4.5 shrink-0" />
        <span>{m.body}</span>
        <span className="text-xs">{m.time}</span>
      </div>
    )
  }

  const interactive = !compact && !selectMode
  const row = (
    <div
      id={`dpv-${m.id}`}
      onClick={selectMode ? onToggleSelect : undefined}
      className={[
        "group relative -mx-2 flex gap-2 rounded px-2 transition-colors",
        m.grouped ? "py-0.5" : "py-1",
        highlighted ? "bg-primary/15" : selected ? "bg-primary/10" : "hover:bg-accent/40",
        selectMode ? "cursor-pointer" : "",
      ].join(" ")}
    >
      {selectMode && (
        <span className="mt-1 shrink-0 text-muted-foreground">
          {selected ? <CheckSquare className="size-5 text-primary" /> : <Square className="size-5" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
      {!compact && !selectMode && (
        <div className={`absolute -top-3 right-2 z-20 flex items-center gap-0.5 rounded-md border border-border bg-popover px-1 py-0.5 shadow-[var(--e2)] transition-opacity duration-150 ${toolbarOpen ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
          <EmojiPickerPopover side="bottom" align="end" onPick={() => {}} onOpenChange={setToolbarOpen}>
            <button className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:text-foreground" aria-label="Add reaction">
              <SmilePlus className="size-4.5" />
            </button>
          </EmojiPickerPopover>
          {[Reply, Pencil].map((Icon, i) => (
            <button key={i} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
              <Icon className="size-4.5" />
            </button>
          ))}
          <DropdownMenu onOpenChange={setToolbarOpen}>
            <DropdownMenuTrigger
              render={<button className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:text-foreground" />}
            >
              <MoreHorizontal className="size-4.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <MessageDropdownItems onStartSelect={() => onStartSelect?.()} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {m.reply && (
        <button onClick={onJumpReply} className="mb-0.5 ml-13 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <div className="h-2 w-4 rounded-tl-md border-l-2 border-t-2 border-border" />
          <span className="font-medium text-foreground/80">@{m.reply.author}</span>
          <span className="truncate">{m.reply.text}</span>
        </button>
      )}

      <div className="flex gap-3">
        {m.grouped ? (
          <div className="w-10 shrink-0" />
        ) : m.webhook ? (
          <Avatar label={m.avatar ?? "?"} size={40} />
        ) : (
          <button onClick={(e) => onOpenProfile?.(m.author ?? "", e)} className="shrink-0 self-start">
            <Avatar label={m.avatar ?? "?"} size={40} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {!m.grouped && (
            <div className="flex items-baseline gap-2">
              <button
                onClick={(e) => !m.webhook && onOpenProfile?.(m.author ?? "", e)}
                className="font-medium hover:underline"
                style={{ color: m.color ?? "var(--foreground)" }}
              >
                {m.author}
              </button>
              {m.webhook && (
                <span className="rounded-sm bg-primary/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary">App</span>
              )}
              <span className="text-xs text-muted-foreground">{m.time}</span>
            </div>
          )}
          {m.body && (
            <div className="inline">
              <MessageBody text={m.body} />
              {m.edited && <span className="ml-1 align-baseline text-[11px] text-muted-foreground">(edited)</span>}
            </div>
          )}

          {m.attachments && (
            <div className="mt-1.5 flex flex-col gap-2">
              {m.attachments.map((a, i) =>
                a.kind === "image" ? (
                  // faux image thumbnail — fixed aspect so there's no CLS on load
                  <div key={i} className="flex aspect-16/10 w-full max-w-[320px] flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted text-muted-foreground">
                    <ImageIcon className="size-7" />
                    <span className="text-xs">{a.name}</span>
                  </div>
                ) : (
                  <div key={i} className="flex w-full max-w-[320px] items-center gap-3 rounded-md border border-border bg-card p-2.5">
                    <FileText className="size-7 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-primary">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{a.size}</div>
                    </div>
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                ),
              )}
            </div>
          )}

          {m.embed && (
            <article
              className="mt-1.5 max-w-108 overflow-hidden rounded-md border-l-4 bg-card p-3"
              style={{ borderLeftColor: m.embed.color ?? "var(--border)" }}
            >
              {/* author row (bot embeds) */}
              {m.embed.author && (
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{m.embed.author.avatar}</span>
                  <span className="text-xs font-medium">{m.embed.author.name}</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground">{m.embed.provider}</div>
              <a className="mt-0.5 block font-medium text-primary hover:underline">{m.embed.title}</a>
              <p className="mt-1 text-sm text-muted-foreground">{m.embed.desc}</p>

              {/* fields grid (inline fields share a row) */}
              {m.embed.fields && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {m.embed.fields.map((f, i) => (
                    <div key={i} className={f.inline ? "min-w-[30%] flex-1" : "w-full"}>
                      <div className="text-xs font-semibold">{f.name}</div>
                      <div className="text-xs text-muted-foreground">{f.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* faux OG poster */}
              {m.embed.image && (
                <div className="mt-2 flex aspect-40/21 w-full max-w-100 flex-col justify-between rounded-sm bg-[oklch(0.95_0.02_85)] p-4 text-[oklch(0.25_0.02_60)]">
                  <span className="font-mono text-[11px] opacity-70">alook.ai</span>
                  <span className="font-heading text-xl font-semibold leading-tight">Your Personal<br />Company</span>
                  <span className="text-[10px] opacity-60">AI agents that collaborate, stay always on, and learn.</span>
                </div>
              )}

              {m.embed.footer && <div className="mt-2 text-[11px] text-muted-foreground">{m.embed.footer}</div>}
            </article>
          )}

          {m.reactions && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {m.reactions.map((r, i) => (
                <button
                  key={i}
                  className={[
                    "flex h-6 items-center gap-1 rounded-md px-1.5 text-sm",
                    r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
                  ].join(" ")}
                >
                  <span>{r.emoji}</span>
                  <span className="text-xs text-muted-foreground">{r.count}</span>
                </button>
              ))}
              <EmojiPickerPopover side="top" align="start" onPick={() => {}}>
                <button className="grid h-6 w-7 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add reaction">
                  <SmilePlus className="size-4" />
                </button>
              </EmojiPickerPopover>
            </div>
          )}

          {m.thread && !compact && (
            <button
              onClick={() => onOpenThread(m.thread!.id)}
              className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-sm hover:bg-accent"
            >
              <MessagesSquare className="size-4 text-muted-foreground" />
              <span className="font-medium text-foreground">{m.thread.name}</span>
              <span className="text-xs text-muted-foreground">{m.thread.count} messages</span>
              <ChevronDown className="size-4 -rotate-90 text-muted-foreground" />
            </button>
          )}

          {m.failed && (
            <button className="mt-1 flex items-center gap-1.5 text-xs text-destructive hover:underline">
              <X className="size-3.5" /> Message failed to send. Click to retry.
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  )

  // right-click opens the action menu (only on full, non-select rows)
  if (!interactive) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="w-48">
        <MessageContextItems onStartSelect={() => onStartSelect?.()} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── DM sidebar (@me view) ──────────────────────────────────────────────────
function DmSidebar({
  activeDm, onPickDm, onShowFriends, bordered, noHeader,
}: {
  activeDm: string | null
  onPickDm: (id: string) => void
  onShowFriends: () => void
  bordered?: boolean
  noHeader?: boolean
}) {
  return (
    <aside className={`flex min-w-0 flex-1 flex-col ${bordered ? "rounded-tl-xl border-l border-t border-border" : ""}`}>
      {!noHeader && (
        <header className="flex h-12 items-center gap-2 border-b border-border px-3">
          <button className="flex h-8 flex-1 items-center rounded-md bg-secondary px-2 text-sm text-muted-foreground hover:text-foreground">
            Find or start a conversation
          </button>
        </header>
      )}
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-3">
        <button
          onClick={onShowFriends}
          className={[
            "mb-2 flex h-9 w-full items-center gap-2 rounded-md px-2 text-[15px] font-medium",
            activeDm === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          ].join(" ")}
        >
          <Users className="size-5" /> Friends
        </button>
        <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Direct Messages</span>
          <Plus className="size-3.5" />
        </div>
        {DMS.map((d) => {
          const active = d.id === activeDm
          return (
            <button
              key={d.id}
              onClick={() => onPickDm(d.id)}
              className={[
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              ].join(" ")}
            >
              <div className="relative shrink-0">
                <Avatar label={d.avatar} size={32} />
                <PresenceDot status={d.status} />
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-[15px] leading-tight text-foreground">{d.name}</div>
                <div className="truncate text-xs leading-tight text-muted-foreground">{d.preview}</div>
              </div>
              {d.unread && <span className="size-2 shrink-0 rounded-full bg-primary" />}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function DmHeader({ dm, onBack }: { dm: DM; onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <div className="relative shrink-0">
        <Avatar label={dm.avatar} size={24} />
        <PresenceDot status={dm.status} />
      </div>
      <h1 className="truncate text-base font-medium">{dm.name}</h1>
      <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Pinned"><Pin className="size-5" /></Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Add friend"><UserPlus className="size-5" /></Button>
      </div>
    </header>
  )
}

function DmMessages({ dm, onOpenProfile }: { dm: DM; onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  return (
    <div className="flex-1 overflow-y-auto thin-scrollbar">
      <div className="flex min-h-full flex-col justify-end gap-4 px-4 py-5">
        <div className="mb-2">
          <div className="relative mb-3 w-fit">
            <Avatar label={dm.avatar} size={68} />
          </div>
          <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.
          </p>
        </div>
        <DateDivider label="May 11, 2026" />
        {dm.messages.map((m) => (
          <Message key={m.id} m={m} onOpenThread={() => {}} onOpenProfile={onOpenProfile} />
        ))}
      </div>
    </div>
  )
}

// ── Friends page (@me, no DM selected) ──────────────────────────────────────
function FriendsPage({
  onBack, hamburger, onOpenProfile,
}: {
  onBack?: () => void
  hamburger?: () => void
  onOpenProfile?: (name: string, e: React.MouseEvent) => void
}) {
  const onlineFriends = FRIENDS.filter((f) => f.status === "online")

  const friendList = (list: Friend[], title: string) => (
    <FriendSection title={`${title} — ${list.length}`} count={list.length} emptyLabel="No friends yet. Search for users to add.">
      {list.map((f) => (
        <button
          key={f.id}
          onClick={(e) => onOpenProfile?.(f.name, e)}
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
          style={{ opacity: f.status === "offline" ? 0.5 : 1 }}
        >
          <div className="relative shrink-0">
            <Avatar label={f.avatar} size={32} />
            <PresenceDot status={f.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium">{f.name}</div>
            <div className="truncate text-xs text-muted-foreground">{f.sub}</div>
          </div>
          <span className="grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground"><MessagesSquare className="size-4" /></span>
        </button>
      ))}
    </FriendSection>
  )

  return (
    <Tabs defaultValue="online" className="min-h-0 flex-1">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
        )}
        {hamburger && (
          <Button variant="ghost" size="icon-sm" onClick={hamburger} className="text-muted-foreground hover:text-foreground" aria-label="Open DMs"><Menu className="size-5" /></Button>
        )}
        <Users className="size-5 text-muted-foreground" />
        <h1 className="text-base font-medium">Friends</h1>
        <TabsList variant="line" className="ml-2">
          <TabsTrigger value="online">Online</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="blocked">Blocked</TabsTrigger>
        </TabsList>
        <Button size="sm" className="ml-1">Add Friend</Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto thin-scrollbar p-4">
        {/* add-friend bar (shared across tabs) */}
        <div className="mb-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add Friend</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <AtSign className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-11 pl-9" placeholder="Enter a username to add a friend" />
            </div>
            <Button>Send</Button>
          </div>
        </div>

        <TabsContent value="online">{friendList(onlineFriends, "Online")}</TabsContent>
        <TabsContent value="all">{friendList(FRIENDS, "All Friends")}</TabsContent>
        <TabsContent value="pending">
          <FriendSection title={`Pending — ${PENDING.length}`} count={PENDING.length} emptyLabel="No pending requests. When someone adds you, it'll show up here.">
            {PENDING.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent">
                <Avatar label={p.avatar} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.kind === "incoming" ? "Incoming request" : "Outgoing request"}</div>
                </div>
                {p.kind === "incoming" ? (
                  <div className="flex gap-1.5">
                    <button className="grid size-8 place-items-center rounded-full bg-secondary text-status-online hover:bg-accent" aria-label="Accept"><Check className="size-4" /></button>
                    <button className="grid size-8 place-items-center rounded-full bg-secondary text-destructive hover:bg-accent" aria-label="Reject"><X className="size-4" /></button>
                  </div>
                ) : (
                  <button className="grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground hover:bg-accent" aria-label="Cancel"><X className="size-4" /></button>
                )}
              </div>
            ))}
          </FriendSection>
        </TabsContent>
        <TabsContent value="blocked">
          <FriendSection title={`Blocked — ${BLOCKED.length}`} count={BLOCKED.length} emptyLabel="You haven't blocked anyone.">
            {BLOCKED.map((b) => (
              <div key={b.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent">
                <Avatar label={b.avatar} size={32} dim />
                <div className="min-w-0 flex-1 truncate text-[15px] font-medium">{b.name}</div>
                <Button variant="secondary" size="sm">Unblock</Button>
              </div>
            ))}
          </FriendSection>
        </TabsContent>
      </div>
    </Tabs>
  )
}

function FriendSection({ title, count, emptyLabel, children }: { title: string; count: number; emptyLabel: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {count === 0 ? <EmptyState icon={Users} label={emptyLabel} /> : <div className="flex flex-col">{children}</div>}
    </div>
  )
}

// ── Empty state — holds the frame, teaches what goes here (DESIGN.md) ────────
function EmptyState({ icon: Icon, label }: { icon: typeof Users; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-7" />
      </div>
      <p className="max-w-65 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

// ── Server settings (full-screen view) ──────────────────────────────────────
function ServerSettings({
  section, setSection, onClose, onOpenProfile,
}: {
  section: SettingsSection
  setSection: (s: SettingsSection) => void
  onClose: () => void
  onOpenProfile?: (name: string, e: React.MouseEvent) => void
}) {
  const nav: { id: SettingsSection; label: string; icon: typeof Hash }[] = [
    { id: "overview", label: "Overview", icon: Settings },
    { id: "members", label: "Members", icon: Users },
    { id: "invites", label: "Invites", icon: Link2 },
    { id: "webhooks", label: "Webhooks", icon: MessagesSquare },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "audit", label: "Audit Log", icon: ScrollText },
  ]
  return (
    <Tabs
      orientation="vertical"
      value={section}
      onValueChange={(v) => setSection(v as SettingsSection)}
      className="min-h-0 flex-1 flex-row gap-0"
    >
      {/* settings nav */}
      <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar border-r border-border p-3" style={{ background: "var(--d-rail)" }}>
        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Alook</div>
        <TabsList variant="line" className="h-auto w-full flex-col gap-0.5">
          {nav.map((n) => (
            <TabsTrigger key={n.id} value={n.id} className="h-8 w-full justify-start gap-2">
              <n.icon className="size-4" /> {n.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Separator className="my-1" />
        <Button variant="destructive" size="sm" className="justify-start"><Trash2 className="size-4" /> Delete Server</Button>
      </nav>

      {/* settings body */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="flex-1 text-lg font-semibold capitalize">{section === "audit" ? "Audit Log" : section}</h1>
          <button onClick={onClose} className="flex flex-col items-center text-muted-foreground hover:text-foreground" aria-label="Close settings">
            <span className="grid size-8 place-items-center rounded-full border border-current"><X className="size-4" /></span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto thin-scrollbar p-5">
          <TabsContent value="overview"><SettingsOverview /></TabsContent>
          <TabsContent value="members"><SettingsMembers onOpenProfile={onOpenProfile} /></TabsContent>
          <TabsContent value="invites"><SettingsInvites /></TabsContent>
          <TabsContent value="webhooks"><SettingsWebhooks /></TabsContent>
          <TabsContent value="notifications"><SettingsNotifications /></TabsContent>
          <TabsContent value="audit"><SettingsAudit /></TabsContent>
        </div>
      </div>
    </Tabs>
  )
}

function SettingsOverview() {
  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-4">
        <div className="grid size-20 place-items-center rounded-2xl bg-primary text-2xl font-semibold text-primary-foreground">A</div>
        <div>
          <div className="text-sm font-medium">Server icon</div>
          <div className="text-xs text-muted-foreground">Recommended 512×512. PNG, JPG, or GIF.</div>
          <Button variant="secondary" size="sm" className="mt-2">Upload image</Button>
        </div>
      </div>
      <Field label="Server name"><Input defaultValue="Alook" /></Field>
      <Field label="Description"><Textarea className="h-20 resize-none" defaultValue="Your Personal Company — AI agents that collaborate, always on." /></Field>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </label>
  )
}

function SettingsMembers({ onOpenProfile }: { onOpenProfile?: (name: string, e: React.MouseEvent) => void }) {
  const rows = Object.entries(MEMBERS).flatMap(([role, list]) => list.map((m) => ({ ...m, role })))
  return (
    <div className="space-y-1">
      <div className="mb-2 text-sm text-muted-foreground">{rows.length} members</div>
      {rows.map((m) => (
        <div key={m.name} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <button onClick={(e) => onOpenProfile?.(m.name, e)} className="relative shrink-0">
            <Avatar label={m.avatar} size={32} />
            <PresenceDot status={m.status} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium">{m.name}</div>
            <div className="text-xs text-muted-foreground">{m.role}</div>
          </div>
          <Badge variant="secondary" className="gap-1"><Shield className="size-3.5" /> {m.role}</Badge>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Kick member"><Trash2 className="size-4" /></Button>
        </div>
      ))}
    </div>
  )
}

function SettingsInvites() {
  return (
    <div className="space-y-2">
      {INVITES.map((iv) => (
        <div key={iv.code} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
          <Link2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm">alook.gg/{iv.code}</div>
            <div className="text-xs text-muted-foreground">by {iv.by} · {iv.uses} uses · expires {iv.expires}</div>
          </div>
          <Button variant="secondary" size="sm">Copy</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Revoke invite"><X className="size-4" /></Button>
        </div>
      ))}
      <Button size="sm" className="mt-2">Create invite</Button>
    </div>
  )
}

function SettingsWebhooks() {
  return (
    <div className="space-y-2">
      {WEBHOOKS.map((w) => (
        <div key={w.id} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{w.avatar}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium">{w.name}</div>
            <div className="text-xs text-muted-foreground">posting to #{w.channel}</div>
          </div>
          <Button variant="secondary" size="sm">Copy URL</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Delete webhook"><Trash2 className="size-4" /></Button>
        </div>
      ))}
      <Button size="sm" className="mt-2">New webhook</Button>
    </div>
  )
}

function SettingsNotifications() {
  const levels = ["All messages", "Only @mentions", "Nothing"]
  const [sel, setSel] = useState("Only @mentions")
  return (
    <div className="max-w-md space-y-2">
      <div className="mb-2 text-sm text-muted-foreground">Server notification setting</div>
      {levels.map((l) => (
        <button
          key={l}
          onClick={() => setSel(l)}
          className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left hover:bg-accent"
        >
          <span className={`grid size-4 place-items-center rounded-full border ${sel === l ? "border-primary" : "border-muted-foreground"}`}>
            {sel === l && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <span className="text-sm font-medium">{l}</span>
        </button>
      ))}
    </div>
  )
}

function SettingsAudit() {
  return (
    <div className="space-y-1">
      {AUDIT_LOG.map((e, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{e.actor}</span>{" "}
            <span className="text-muted-foreground">{e.action}</span>{" "}
            <span className="font-medium">{e.target}</span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{e.time}</span>
        </div>
      ))}
    </div>
  )
}

// ── Inbox popover content (rendered inside a shadcn Popover from the top bar) ─
function InboxFeedRows({ unreadOnly }: { unreadOnly?: boolean }) {
  return (
    <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
      {INBOX_FEED.filter((f) => !unreadOnly || f.unread).map((f) => (
        <button key={f.id} className="group flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-accent">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {f.initial}
            {f.unread && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-popover bg-primary" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">You have new messages in <span className="font-semibold">{f.server}</span>.</div>
            <div className="text-xs text-muted-foreground">{f.ago}</div>
          </div>
          <MoreHorizontal className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  )
}

function InboxPopover() {
  return (
    <Tabs defaultValue="foryou">
      <div className="flex items-center gap-2 px-4 pt-3">
        <Inbox className="size-5" />
        <h2 className="flex-1 text-lg font-semibold">Inbox</h2>
        <Badge variant="secondary" className="h-6 gap-1"><Bell className="size-3.5" /> 0</Badge>
      </div>
      <TabsList variant="line" className="mt-2 w-full border-b border-border px-2">
        <TabsTrigger value="foryou">For You</TabsTrigger>
        <TabsTrigger value="unreads">Unreads</TabsTrigger>
        <TabsTrigger value="mentions">Mentions</TabsTrigger>
      </TabsList>
      <TabsContent value="foryou"><InboxFeedRows /></TabsContent>
      <TabsContent value="unreads"><InboxFeedRows unreadOnly /></TabsContent>
      <TabsContent value="mentions">
        <div className="max-h-90 overflow-y-auto thin-scrollbar p-1.5">
          {MENTIONS.length === 0 ? (
            <EmptyState icon={Inbox} label="No mentions yet." />
          ) : (
            MENTIONS.map((mn) => (
              <button key={mn.id} className="flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-accent">
                <Avatar label={mn.m.avatar ?? "?"} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{mn.m.author}</span>{" "}
                    <span className="text-xs text-muted-foreground">in {mn.server} · #{mn.channel}</span>
                  </div>
                  <div className="truncate text-sm text-muted-foreground">{mn.m.body}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </TabsContent>
    </Tabs>
  )
}

// ── Profile card (popover on desktop/tablet, bottom sheet on mobile) ─────────

// ── Profile card (popover on desktop/tablet, bottom sheet on mobile) ─────────
function ProfileCard({ data, x, y, bp, onClose }: { data: Profile; x: number; y: number; bp: Breakpoint; onClose: () => void }) {
  const mobile = bp === "mobile"
  const card = (
    <>
      {/* banner */}
      <div className="-m-2 mb-0 h-16 rounded-t-lg bg-primary/30" />
      <div className="px-2 pb-1">
        <div className="-mt-8 mb-2 flex items-end justify-between">
          <div className="rounded-full ring-4 ring-popover">
            <Avatar label={data.avatar} size={64} />
          </div>
          <Badge variant="secondary" className="mb-1 h-6 gap-1"><Shield className="size-3.5" /> {data.role}</Badge>
        </div>
        <div className="rounded-lg bg-card p-3">
          <div className="text-lg font-semibold">{data.name}</div>
          <Separator className="my-2" />
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">About Me</div>
          <p className="mt-1 text-sm">{data.about}</p>
          <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mutual Servers</div>
          <p className="mt-1 text-sm text-muted-foreground">{data.mutual} servers in common</p>
          <div className="mt-3 flex h-9 items-center gap-2 rounded-md bg-secondary px-2">
            <input className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder={`Message @${data.name}`} />
            <MessagesSquare className="size-4 text-muted-foreground" />
          </div>
        </div>
      </div>
    </>
  )

  // mobile: bottom sheet (intentional mobile UX, kept manual)
  if (mobile)
    return (
      <div className="fixed inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
        <div className="absolute inset-0 bg-foreground/30" />
        <div className="relative p-3" onClick={(e) => e.stopPropagation()}>
          <div className="overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">{card}</div>
        </div>
      </div>
    )

  // desktop/tablet: shadcn Popover anchored to an invisible trigger at the click point
  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose() }}>
      <PopoverTrigger
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed size-0"
        style={{ left: x, top: y }}
      />
      <PopoverContent side="right" align="start" sideOffset={8} className="w-75 overflow-hidden p-2">
        {card}
      </PopoverContent>
    </Popover>
  )
}
