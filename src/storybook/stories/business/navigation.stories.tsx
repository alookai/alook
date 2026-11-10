import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { useState } from "react"
import { AccountFixtures } from "../../preview/business-fixtures"
import { ChannelSidebarTreeOwner } from "@/components/community/channels/channel-sidebar-tree-owner"
import { ServerRail } from "@/components/community/shell/server-rail"
import { DEMO_CHANNELS, DEMO_SERVERS } from "@/components/home/landing-interactive-shell-data"
import { EntityIcon } from "@/components/community/entity-icon"
import { DropLine } from "@/components/community/drop-line"
import { ChannelUnreadIndicator } from "@/components/community/channels/channel-unread-indicator"
import { RailIcon } from "@/components/community/shell/rail-icon"
import { ServerIcon } from "@/components/community/server-icon"
import { COMMUNITY_SIDEBAR_DEFAULT_WIDTH, COMMUNITY_SIDEBAR_MAX_WIDTH, COMMUNITY_SIDEBAR_MIN_WIDTH } from "@/components/community/shell/shell-frame-geometry"

function NavigationExample({ admin = true, grouped = false }: { admin?: boolean; grouped?: boolean }) { const [server, setServer] = useState(DEMO_SERVERS[0]!.id); const [channel, setChannel] = useState("demo-general"); return <div className="flex h-160 overflow-hidden"><div className="w-14 shrink-0"><ServerRail servers={DEMO_SERVERS} folders={grouped ? [{ id: "storybook-folder", name: "Projects", servers: DEMO_SERVERS.slice(0, 2) }] : []} activeServerId={server} view="server" bottomInset={0} onHome={fn()} onServer={fn()} onServerNavigate={setServer} /></div><div className="w-72 max-w-full"><ChannelSidebarTreeOwner key={server} scopeKey={`storybook:${server}`} categories={DEMO_CHANNELS[server] ?? []} serverName={DEMO_SERVERS.find((item) => item.id === server)?.name ?? "Studio"} activeChannel={channel} setActiveChannel={setChannel} isAdmin={admin} currentUserId="demo-gus" serverId={server} onOpenSettings={fn()} onCreateChannel={fn()} onCreateCategory={fn()} onDeleteChannel={fn()} onDeleteCategory={fn()} onUpdateCategory={fn()} onRenameChannel={fn()} onReorderCategories={fn()} onReorderChannels={fn()} /></div></div> }
const meta = { title: "Web/Business/Navigation", component: NavigationExample, tags: ["ai-generated"], decorators: [(Story) => <AccountFixtures><Story /></AccountFixtures>], args: { admin: true, grouped: false } } satisfies Meta<typeof NavigationExample>
export default meta
type Story = StoryObj<typeof meta>
export const Admin: Story = {}
export const Member: Story = { args: { admin: false } }
export const GlyphsAndIndicators: Story = { render: () => <div className="flex flex-wrap items-center gap-6"><EntityIcon kind="text" /><EntityIcon kind="forum" /><EntityIcon kind="thread" /><ServerIcon id="storybook-server" name="Studio" initial="S" /><div className="w-14"><RailIcon label="A" active /><RailIcon label="+" accent /></div><div className="relative border border-border px-4 py-3"><DropLine side="top" /><ChannelUnreadIndicator visible />Unread channel</div></div> }

export const Folder: Story = { args: { grouped: true } }

function ForumNavigationExample() {
  const [thread, setThread] = useState<string | null>("storybook-post-one")
  const categories = [{ id: "storybook-category", name: "项目讨论 Project discussions", channels: [
    { id: "storybook-forum", name: "design-feedback-设计反馈", type: "forum" as const, active: false, unread: false },
  ] }]
  const threads = ["one", "two"].map((suffix, index) => ({
    id: `storybook-post-${suffix}`, parentChannelId: "storybook-forum", parentMessageId: `storybook-opener-${suffix}`,
    title: index ? "第二个讨论：Long thread title for navigation" : "设计反馈：Thread selection and narrow labels",
    activityAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", unread: false,
  }))
  return <div className="flex h-160 min-h-0 flex-col overflow-x-auto overflow-y-auto bg-sidebar thin-scrollbar"
    style={{ width: COMMUNITY_SIDEBAR_DEFAULT_WIDTH, minWidth: COMMUNITY_SIDEBAR_MIN_WIDTH, maxWidth: COMMUNITY_SIDEBAR_MAX_WIDTH, resize: "horizontal" }}>
    <ChannelSidebarTreeOwner scopeKey="storybook:forum-selection" categories={categories} serverName="设计工作室 Design studio"
      activeChannel="storybook-forum" setActiveChannel={() => setThread(null)} activeThreadId={thread}
      forumThreadsByParent={{ "storybook-forum": threads }} onSelectForumThread={(_, id) => setThread(id)}
      isAdmin onOpenSettings={fn()} onCreateChannel={fn()} onCreateCategory={fn()} onUpdateCategory={fn()} />
  </div>
}

export const ForumThreads: Story = { render: () => <ForumNavigationExample /> }

function ForumCountExample() {
  const [active, setActive] = useState("selected-forum")
  const categories = [{ id: "review", name: "Workspace", channels: [
    { id: "general", name: "general", type: "text" as const, active: false, unread: true },
    { id: "read-forum", name: "design", type: "forum" as const, active: false, unread: false, unarchivedPostCount: 12 },
    { id: "unread-forum", name: "issues", type: "forum" as const, active: false, unread: true, unarchivedPostCount: 12 },
    { id: "selected-forum", name: "planning", type: "forum" as const, active: false, unread: false, unarchivedPostCount: 8 },
    { id: "loading-forum", name: "backlog", type: "forum" as const, active: false, unread: false },
    { id: "empty-forum", name: "releases", type: "forum" as const, active: false, unread: false, unarchivedPostCount: 0 },
    { id: "long-forum", name: "项目讨论与产品反馈", type: "forum" as const, active: false, unread: true, unarchivedPostCount: 1482 },
    { id: "muted-forum", name: "research", type: "forum" as const, active: false, unread: true, muted: true, unarchivedPostCount: 24 },
  ] }]
  return <div className="flex flex-wrap items-start gap-8" data-forum-count-review>
    {[256, 152].map(width => <div key={width}>
      <p className="mb-4 text-sm text-muted-foreground">{width === 256 ? "Standard sidebar" : "Minimum sidebar"}</p>
      <div style={{ width }} className="h-96 bg-sidebar" data-forum-count-width={width}>
        <ChannelSidebarTreeOwner scopeKey={`count-review:${width}`} categories={categories} serverName="Studio"
          activeChannel={active} setActiveChannel={setActive} isAdmin={false} currentUserId="demo-gus" />
      </div>
    </div>)}
  </div>
}
export const ForumCounts: Story = { render: () => <ForumCountExample /> }
