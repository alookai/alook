/**
 * Mock data for the /d-preview scaffolding page.
 *
 * This file is DISPOSABLE — it exists only to feed the reusable
 * `@/components/community/*` components in the preview. Once the real
 * `/community` app ships, the query layer returns these same view-model
 * shapes from `community_*` rows and this file (plus the preview page) is deleted.
 *
 * Field names match `@/components/community/_types` (schema-aligned), e.g.
 * `content`/`authorName`/`authorAvatar`/`createdAt`/`embeds[]`/`replyTo`/
 * `messageCount`/`lastMessageAt`.
 */

import type {
  Server,
  CommunityFolder,
  Category,
  Msg,
  Thread,
  ForumPost,
  Member,
  Friend,
  PendingRequest,
  BlockedUser,
  DM,
  Profile,
  InviteRow,
  AuditEntry,
  Mention,
  ForYouEvent,
  UnreadServer,
} from "@/components/community/_types"

export const SERVERS: Server[] = [
  { id: "sv_alook", name: "Alook", initial: "A", active: true, mentions: 0 },
  { id: "sv_cf", name: "Cloudflare", initial: "CF", active: false, mentions: 3 },
  { id: "sv_oss", name: "OSS Club", initial: "OS", active: false, mentions: 0 },
]

export const CATEGORIES: Category[] = [
  {
    // empty name = uncategorized: top-level channels render above all categories, no header.
    // Every server has a default top-level "all" channel.
    id: "cat_none",
    name: "",
    channels: [
      { id: "all", name: "all", active: false, unread: false },
    ],
  },
  {
    id: "cat_info",
    name: "WELCOME",
    channels: [
      { id: "welcome", name: "welcome", active: true, unread: false },
      { id: "rules", name: "rules", active: false, unread: false },
    ],
  },
  {
    id: "cat_community",
    name: "COMMUNITY",
    channels: [
      { id: "general", name: "general", active: false, unread: false },
      { id: "show-and-tell", name: "show-and-tell", active: false, unread: true },
      { id: "ideas-feedback", name: "ideas-feedback", active: false, unread: false },
      { id: "help-forum", name: "help-forum", active: false, unread: false, type: "forum" },
    ],
  },
  {
    id: "cat_dev",
    name: "DEVELOPERS",
    channels: [
      { id: "dev-chat", name: "dev-chat", active: false, unread: false },
      { id: "api", name: "api-integrations", active: false, unread: false },
      { id: "off-topic", name: "off-topic", active: false, unread: true, muted: true },
    ],
  },
]

export const MESSAGES: Msg[] = [
  {
    id: "m1", authorName: "Gener", color: "var(--foreground)", createdAt: "2026-06-24T21:27:00Z",
    authorAvatar: "G",
    content: "👋 Welcome to the Alook Community!\n\nAlook lets you run your own AI-powered personal company — agents that collaborate, stay always on, and learn from every task.",
    embeds: [{
      provider: "alook.ai",
      url: "https://alook.ai",
      title: "Alook — Personal Company",
      desc: "Your AI agents, always on. Give them an email, let them work for you around the clock.",
      image: { url: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600&q=80" },
    }],
    reactions: [{ emoji: "👍", count: 3, me: true, userIds: ["u_gener", "u_gus", "u_lindsay"] }],
    thread: { id: "thr_research", name: "Research team setup", messageCount: 3 },
  },
  {
    id: "m2", authorName: "Gus", createdAt: "2026-06-24T21:31:00Z", authorAvatar: "Gu",
    content: "this is exactly what I needed — the email-per-agent thing is wild",
  },
  {
    id: "m3", authorName: "Gus", createdAt: "2026-06-24T21:31:30Z", authorAvatar: "Gu",
    content: "is there a template for a research team?",
  },
  {
    id: "m4", authorName: "Lindsay", createdAt: "2026-06-24T21:42:00Z", authorAvatar: "L",
    replyTo: { id: "m3", authorName: "Gus", text: "is there a template for a research team?" },
    content: "Yes — check the Templates page, there's a Research Analyst preset. Deploys in a minute.",
    reactions: [{ emoji: "🔥", count: 2, me: false, userIds: ["u_gus", "u_tomy"] }, { emoji: "🙏", count: 1, me: false, userIds: ["u_gus"] }],
  },
  {
    id: "m5", authorName: "Gener", createdAt: "2026-06-24T21:45:00Z", authorAvatar: "G",
    content: "Here's the **setup** in *three* steps:\n> Clone the repo first\n`pnpm install`\n```\npnpm dev --filter web\n```\nThat's it ~~maybe~~ ||it just works||",
  },
  {
    id: "ms1", type: "system", systemKind: "join", createdAt: "2026-06-25T10:00:00Z",
    content: "Azzo joined the server.",
  },
  {
    id: "m6", authorName: "Gus", createdAt: "2026-06-25T10:02:00Z", authorAvatar: "Gu",
    content: "thanks @Lindsay — can you cross-post this in #general? cc @everyone",
  },
  {
    id: "m7", authorName: "Lindsay", createdAt: "2026-06-25T10:05:00Z", authorAvatar: "L",
    content: "here's the preset config + a screenshot of the result",
    attachments: [
      { kind: "image", name: "research-preset.png", url: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&q=80" },
      { kind: "file", name: "research-team.json", url: "#", size: "4.2 KB" },
    ],
  },
  {
    id: "m8", authorName: "Release Notes", createdAt: "2026-06-25T10:10:00Z", authorAvatar: "RN",
    embeds: [{
      provider: "GitHub",
      url: "https://github.com/alookai/alook/releases/tag/v0.1.0",
      title: "alook v0.1.0",
      color: "var(--primary)",
      author: { name: "alookai/alook", iconUrl: "https://github.githubassets.com/favicons/favicon-dark.svg" },
      desc: "Threads, forum channels, DMs, and emoji reactions are live. Full changelog below.",
      thumbnail: { url: "https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png" },
      fields: [
        { name: "Added", value: "Threads, Forum channels, DMs", inline: true },
        { name: "Fixed", value: "SMTP timeout, hydration warnings", inline: true },
        { name: "Contributors", value: "@Gener, @Lindsay, @Gus", inline: false },
      ],
      footer: { text: "Released 6/24/26 · 142 commits" },
    }],
  },
  {
    id: "m9", authorName: "Gener", createdAt: "2026-06-25T10:15:00Z", authorAvatar: "G",
    content: "trying the new preset now…", failed: true,
  },
]

// index in MESSAGES where the "NEW" unread divider sits (before this message)
export const NEW_DIVIDER_BEFORE = "m6"

export const PINNED: Msg[] = [MESSAGES[0], MESSAGES[3]]

export const SEARCH_RESULTS: Msg[] = [MESSAGES[3], MESSAGES[1]]

export const THREADS: Thread[] = [
  {
    id: "thr_research",
    name: "Research team setup",
    messageCount: 3,
    lastMessageAt: "2026-06-24T21:36:00Z",
    parent: { authorName: "Gener", text: "👋 Welcome to the Alook Community!" },
  },
  {
    id: "thr_billing",
    name: "Billing & limits questions",
    messageCount: 5,
    lastMessageAt: "2026-06-24T20:12:00Z",
    parent: { authorName: "jgtech", text: "how do per-agent usage limits work?" },
  },
  {
    id: "thr_selfhost",
    name: "Self-hosting on Cloudflare",
    messageCount: 2,
    lastMessageAt: "2026-06-23T15:30:00Z",
    parent: { authorName: "distagon", text: "anyone running this on their own Workers account?" },
  },
]

// ── Forum posts (a forum channel is a list of posts; each post is a thread) ──
export const FORUM_POSTS: Record<string, ForumPost[]> = {
  "help-forum": [
    {
      id: "fp_smtp", name: "Custom SMTP keeps timing out", authorAvatar: "j", messageCount: 6, lastMessageAt: "2026-06-25T09:50:00Z",
      tags: ["email", "bug"], preview: "I set up a custom SMTP relay but sends time out after ~30s…",
      parent: { authorName: "jgtech", text: "I set up a custom SMTP relay but sends time out after ~30s. Anyone seen this?" },
    },
    {
      id: "fp_preset", name: "Share your best agent presets", authorAvatar: "L", messageCount: 23, lastMessageAt: "2026-06-25T09:00:00Z",
      tags: ["showcase"], preview: "Drop your favorite agent setups here — let's build a library.",
      parent: { authorName: "Lindsay", text: "Drop your favorite agent setups here — let's build a library." },
    },
    {
      id: "fp_pricing", name: "How do per-agent limits scale?", authorAvatar: "A", messageCount: 4, lastMessageAt: "2026-06-25T07:30:00Z",
      tags: ["question", "billing"], preview: "Trying to understand how message limits work across a team…",
      parent: { authorName: "Azzo", text: "Trying to understand how message limits work across a team of agents." },
    },
  ],
}

// Mock message streams for threads, forum posts, and DMs. The live app loads
// these into `ctx.messages` once the user navigates into the surface; the
// preview keeps them keyed by surface id so the takeover view can read them
// the same way (look up the active id → get a message list).
export const THREAD_MESSAGES: Record<string, Msg[]> = {
  thr_research: [
    { id: "t1", authorName: "Gus", createdAt: "2026-06-24T21:33:00Z", authorAvatar: "Gu", content: "what roles should the research team have?" },
    { id: "t2", authorName: "Lindsay", createdAt: "2026-06-24T21:35:00Z", authorAvatar: "L", content: "Analyst, Summarizer, and a Fact-checker works well. Give each its own `@inbox`." },
    { id: "t3", authorName: "Gener", createdAt: "2026-06-24T21:36:00Z", authorAvatar: "G", content: "nice — shipping that preset 🚀" },
  ],
  thr_billing: [
    { id: "b1", authorName: "jgtech", createdAt: "2026-06-24T20:05:00Z", authorAvatar: "j", content: "is there a cap on messages per agent?" },
    { id: "b2", authorName: "Gener", createdAt: "2026-06-24T20:12:00Z", authorAvatar: "G", content: "Soft limits per plan — you can raise them in **Settings → Usage**." },
  ],
  thr_selfhost: [
    { id: "s1", authorName: "lucky tomy", createdAt: "2026-06-23T15:30:00Z", authorAvatar: "t", content: "yep — `wrangler deploy` and point D1 + R2 at your own buckets." },
  ],
  fp_smtp: [
    { id: "fp_smtp_1", authorName: "jgtech", createdAt: "2026-06-25T09:02:00Z", authorAvatar: "j", content: "I set up a custom SMTP relay but sends time out after ~30s. Anyone seen this?" },
    { id: "fp_smtp_2", authorName: "Lindsay", createdAt: "2026-06-25T09:08:00Z", authorAvatar: "L", content: "Check the port — `587` with STARTTLS works, `465` sometimes hangs on Workers." },
    { id: "fp_smtp_3", authorName: "jgtech", createdAt: "2026-06-25T09:14:00Z", authorAvatar: "j", content: "587 fixed it 🙏 thank you!" },
  ],
  fp_preset: [
    { id: "fp_preset_1", authorName: "Lindsay", createdAt: "2026-06-25T07:00:00Z", authorAvatar: "L", content: "Drop your favorite agent setups here — let's build a library." },
    { id: "fp_preset_2", authorName: "Gus", createdAt: "2026-06-25T07:20:00Z", authorAvatar: "Gu", content: "Research Analyst + Fact-checker combo has been 🔥 for me" },
  ],
  fp_pricing: [
    { id: "fp_pricing_1", authorName: "Azzo", createdAt: "2026-06-25T06:30:00Z", authorAvatar: "A", content: "Trying to understand how message limits work across a team of agents." },
    { id: "fp_pricing_2", authorName: "Gener", createdAt: "2026-06-25T06:45:00Z", authorAvatar: "G", content: "Limits are per-workspace, pooled across agents. Raise them in **Settings → Usage**." },
  ],
}

export const FORUM_TAGS = ["All", "question", "bug", "showcase", "email", "billing"]

// Flat member list with a single role. The member list / settings derive
// display groups (hoisted role groups, then Online/Offline) from this. Gener is the
// Owner (server creator) — there is exactly one, and it can't be reassigned via the UI.
export const MEMBERS: Member[] = [
  { id: "m_gener", userId: "u_gener", name: "Gener", avatar: "G", status: "online", sub: "", role: "owner" },
  { id: "m_gus", userId: "u_gus", name: "Gus", avatar: "Gu", status: "online", sub: "", role: "admin" },
  { id: "m_lindsay", userId: "u_lindsay", name: "Lindsay", avatar: "L", status: "online", sub: "", role: "admin" },
  { id: "m_tomy", userId: "u_tomy", name: "lucky tomy", avatar: "t", status: "online", sub: "AI engineer", role: "member" },
  { id: "m_jgtech", userId: "u_jgtech", name: "jgtech", avatar: "j", status: "online", sub: "", role: "member" },
  { id: "m_azzo", userId: "u_azzo", name: "Azzo", avatar: "A", status: "offline", sub: "", role: "member" },
  { id: "m_distagon", userId: "u_distagon", name: "distagon", avatar: "d", status: "offline", sub: "", role: "member" },
  { id: "m_reece", userId: "u_reece", name: "Reece", avatar: "R", status: "offline", sub: "", role: "member" },
]

export const FRIENDS: Friend[] = [
  { id: "u_gus", name: "Gus", discriminator: "1337", avatar: "Gu", status: "online", sub: "Playing with agents" },
  { id: "u_lindsay", name: "Lindsay", discriminator: "0007", avatar: "L", status: "online", sub: "Online" },
  { id: "u_tomy", name: "lucky tomy", discriminator: "2718", avatar: "t", status: "online", sub: "AI engineer" },
  { id: "u_azzo", name: "Azzo", discriminator: "4404", avatar: "A", status: "offline", sub: "Offline" },
  { id: "u_reece", name: "Reece", discriminator: "8080", avatar: "R", status: "offline", sub: "Offline" },
]

export const PENDING: PendingRequest[] = [
  { id: "u_jg", name: "jgtech", avatar: "j", kind: "incoming" },
  { id: "u_dist", name: "distagon", avatar: "d", kind: "outgoing" },
]

export const BLOCKED: BlockedUser[] = [
  { id: "u_spam", name: "spammer42", avatar: "s" },
]

export const DMS: DM[] = [
  {
    id: "dm_lindsay", userId: "u_lindsay", name: "Lindsay", discriminator: "0007", avatar: "L", status: "online",
    preview: "shipping that preset 🚀", unread: true,
  },
  {
    id: "dm_gus", userId: "u_gus", name: "Gus", discriminator: "1337", avatar: "Gu", status: "online",
    preview: "the email-per-agent thing is wild",
  },
  {
    id: "dm_tomy", userId: "u_tomy", name: "lucky tomy", discriminator: "2718", avatar: "t", status: "offline",
    preview: "wrangler deploy and you're set",
  },
]

export const DM_MESSAGES: Record<string, Msg[]> = {
  dm_lindsay: [
    { id: "d1", authorName: "Lindsay", createdAt: "2026-06-24T21:50:00Z", authorAvatar: "L", content: "hey! saw your research preset — looks great" },
    { id: "d2", authorName: "Gener", createdAt: "2026-06-24T21:51:00Z", authorAvatar: "G", content: "thanks! still tuning the **fact-checker** role" },
    { id: "d3", authorName: "Lindsay", createdAt: "2026-06-24T21:52:00Z", authorAvatar: "L", content: "want me to test it on the Q2 report?" },
  ],
  dm_gus: [
    { id: "g1", authorName: "Gus", createdAt: "2026-06-24T20:30:00Z", authorAvatar: "Gu", content: "can I forward an email straight to an agent?" },
    { id: "g2", authorName: "Gener", createdAt: "2026-06-24T20:31:00Z", authorAvatar: "G", content: "yep — each agent has its own address. just CC it." },
  ],
  dm_tomy: [
    { id: "y1", authorName: "lucky tomy", createdAt: "2026-06-23T14:00:00Z", authorAvatar: "t", content: "self-hosting was easier than I expected" },
  ],
}

export const PROFILES: Record<string, Profile> = {
  Gener: { name: "Gener", discriminator: "0042", avatar: "G", role: "Owner", about: "Building Alook. Coffee, agents, and warm gray UIs.", mutual: 3, tags: ["Owner"] },
  Gus: { name: "Gus", discriminator: "1337", avatar: "Gu", role: "Admin", about: "Tinkering with email-driven workflows.", mutual: 2, tags: ["Admin"] },
  Lindsay: { name: "Lindsay", discriminator: "0007", avatar: "L", role: "Admin", about: "Research lead. Ask me about presets.", mutual: 2, tags: ["Admin"] },
}

export const INVITES: InviteRow[] = [
  { code: "alook-x9f2", uses: 3, maxUses: null, expiresAt: "2026-07-02T12:00:00Z", by: "Gener", creatorId: "u_gener" },
  { code: "alook-team", uses: 12, maxUses: 50, expiresAt: null, by: "Lindsay", creatorId: "u_lindsay" },
]

export const AUDIT_LOG: AuditEntry[] = [
  { actor: "Gener", action: "created channel", target: "#api-integrations", createdAt: "2026-06-25T09:20:00Z" },
  { actor: "Lindsay", action: "kicked member", target: "spammer42", createdAt: "2026-06-25T08:55:00Z" },
  { actor: "Gus", action: "updated role", target: "lucky tomy → Admin", createdAt: "2026-06-25T08:40:00Z" },
  { actor: "Gener", action: "deleted 12 messages", target: "#general", createdAt: "2026-06-24T16:00:00Z" },
]

export const MENTIONS: Mention[] = [
  {
    id: "mn_1", server: "Alook", channel: "general",
    m: { id: "mn_m1", authorName: "Gus", createdAt: "2026-06-25T09:48:00Z", authorAvatar: "Gu", content: "thanks @Gener — can you cross-post this in #general? cc @everyone" },
  },
  {
    id: "mn_2", server: "Cloudflare", channel: "flagship",
    m: { id: "mn_m2", authorName: "roerohan", createdAt: "2026-06-25T08:43:00Z", authorAvatar: "r", content: "@Gener the Workers binding you mentioned fixed it 🙏" },
  },
  {
    id: "mn_3", server: "Alook", channel: "help-forum",
    m: { id: "mn_m3", authorName: "jgtech", createdAt: "2026-06-25T07:14:00Z", authorAvatar: "j", content: "@Gener 587 fixed the SMTP timeout, thank you!" },
  },
]

// "For You" events — direct hits (mentions, replies, thread updates)
export const FOR_YOU_FEED: ForYouEvent[] = [
  {
    eventKey: "mention:mn_m1",
    kind: "mention",
    serverId: "sv_alook",
    serverName: "Alook",
    channelId: "ch_general",
    channelName: "general",
    messageId: "mn_m1",
    authorName: "Gus",
    authorAvatar: "Gu",
    preview: "thanks @Gener — can you cross-post this in #general?",
    createdAt: "2026-06-25T09:48:00Z",
  },
  {
    eventKey: "reply:r_m1",
    kind: "reply",
    serverId: "sv_alook",
    serverName: "Alook",
    channelId: "ch_general",
    channelName: "general",
    messageId: "r_m1",
    authorName: "Lindsay",
    authorAvatar: "L",
    preview: "got it — that approach works for me",
    createdAt: "2026-06-25T09:20:00Z",
  },
  {
    eventKey: "thread:ch_thread_42",
    kind: "thread",
    serverId: "sv_cf",
    serverName: "Cloudflare",
    channelId: "ch_thread_42",
    channelName: "workers-routing",
    messageId: "ch_thread_42",
    authorName: "",
    authorAvatar: "",
    preview: "",
    createdAt: "2026-06-25T08:00:00Z",
  },
]

// Unreads grouped by server — channel-level
export const UNREAD_SERVERS: UnreadServer[] = [
  {
    serverId: "sv_alook",
    serverName: "Alook",
    channels: [
      { channelId: "ch_general", channelName: "general", lastMessageAt: "2026-06-25T10:00:00Z", mentionCount: 1 },
      { channelId: "ch_releases", channelName: "releases", lastMessageAt: "2026-06-25T07:30:00Z", mentionCount: 0 },
    ],
  },
  {
    serverId: "sv_cf",
    serverName: "Cloudflare",
    channels: [
      { channelId: "ch_flagship", channelName: "flagship", lastMessageAt: "2026-06-25T08:43:00Z", mentionCount: 1 },
    ],
  },
]

export const MOCK_FOLDERS: CommunityFolder[] = [
  {
    id: "folder_1",
    name: "AI Projects",
    position: 0,
    servers: [
      { id: "fld_ai", initial: "AI", name: "Acontext" },
      { id: "fld_ml", initial: "ML", name: "memobase" },
    ],
  },
  {
    id: "folder_2",
    name: "Dev",
    position: 1,
    servers: [
      { id: "fld_js", initial: "JS", name: "Second Me" },
      { id: "fld_go", initial: "GO", name: "Midjourney" },
    ],
  },
]
