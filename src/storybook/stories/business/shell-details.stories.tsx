import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { buildDecisionCardEmbed, DecisionCardInputSchema } from "@alook/shared"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { ProfileRunningBotsCardView } from "@/components/community/social/profile-running-bots-card"
import { UserBarExtensionSlot } from "@/components/community/shell/user-bar-extension-slot"
import { UserBar } from "@/components/community/shell/user-bar"
import { InboxPopover, type InboxTab } from "@/components/community/shell/community-inbox-popover"
import type { InboxTodo, UnreadServer } from "@/lib/community/models/inbox"
import { ComposerPreview } from "@/components/community/messages/composer-preview"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { MessageListSkeleton } from "@/components/community/messages/message-list-view"

function EmptyInbox() { return <InboxPopover unreads={[]} unreadDms={[]} mentions={[]} marked={[]} hasProjectedUnreads={false} hasProjectedMentions={false} /> }

function createSampleTodos(): InboxTodo[] {
  const channelCard = buildDecisionCardEmbed(
    DecisionCardInputSchema.parse({
      summary: "Confirm Inbox Todo visual polish before opening the PR",
      questions: [
        {
          id: "layout",
          header: "Layout",
          question: "How should question cards sit inside the Inbox Todo stream?",
          options: [
            { id: "frameless", label: "Frameless floating stickers", description: "Compact source header above each wavy sticker card", recommended: true },
            { id: "boxed", label: "Inside InboxCard boxes", description: "Wrap each sticker inside a bordered card container" },
          ],
        },
        {
          id: "read",
          header: "Read state",
          question: "When a channel has two unread questions, what happens after answering the first?",
          options: [
            { id: "keep", label: "Keep second unread", description: "Only advance lastReadSeq once no unread peer messages remain", recommended: true },
            { id: "clear", label: "Mark whole channel read", description: "Clear all unread messages in that channel immediately" },
          ],
        },
      ],
    }),
    [{ userId: "viewer-1", handle: "gus#1813" }],
  )
  const dmCard = buildDecisionCardEmbed(
    DecisionCardInputSchema.parse({
      summary: "Pick staging deploy window for v0.1.71",
      questions: [
        {
          id: "window",
          header: "Deploy",
          question: "Should we deploy web + ws-do to staging tonight?",
          options: [
            { id: "tonight", label: "Deploy tonight", description: "Right after PR #1384 merges", recommended: true },
            { id: "morning", label: "Tomorrow morning", description: "Batch with daemon release" },
          ],
        },
      ],
    }),
    [{ userId: "viewer-1", handle: "gus#1813" }],
  )
  return [
    {
      id: "question:todo-1",
      messageId: "todo-1",
      channelId: "ch-gus-issues",
      serverId: "srv-alook",
      server: "Alook",
      channel: "gus-issues",
      parentChannelId: null,
      createdAt: "2026-11-21T07:10:00.000Z",
      m: {
        id: "todo-1",
        type: "question",
        seq: 260,
        authorId: "bot-evan",
        authorName: "Evan You",
        createdAt: "2026-11-21T07:10:00.000Z",
        content: "Confirm Inbox Todo visual polish before opening the PR",
        decisionCard: channelCard,
      },
    },
    {
      id: "question:todo-2",
      messageId: "todo-2",
      channelId: "dm-cecilia",
      serverId: null,
      server: "Cecilia",
      channel: "Cecilia",
      parentChannelId: null,
      createdAt: "2026-11-21T06:45:00.000Z",
      m: {
        id: "todo-2",
        type: "question",
        seq: 18,
        authorId: "bot-cecilia",
        authorName: "Cecilia",
        createdAt: "2026-11-21T06:45:00.000Z",
        content: "Pick staging deploy window for v0.1.71",
        decisionCard: dmCard,
      },
    },
  ]
}

const SAMPLE_UNREADS: UnreadServer[] = [
  {
    serverId: "srv-alook",
    serverName: "Alook",
    channels: [
      {
        channelId: "ch-gus-uiux",
        channelName: "gus-uiux",
        type: "text",
        lastMessageAt: "2026-11-24T05:10:00.000Z",
        lastUnreadSeq: 3781,
        unreadCount: 1,
        mentionCount: 0,
        hasDirectUnread: true,
        children: [],
      },
      {
        channelId: "ch-gus-issues",
        channelName: "gus-issues",
        type: "text",
        lastMessageAt: "2026-11-24T05:05:00.000Z",
        lastUnreadSeq: 412,
        unreadCount: 12,
        mentionCount: 1,
        hasDirectUnread: true,
        children: [],
      },
      {
        channelId: "ch-release-ops",
        channelName: "release-ops",
        type: "text",
        lastMessageAt: "2026-11-24T04:55:00.000Z",
        lastUnreadSeq: 920,
        unreadCount: 128,
        mentionCount: 0,
        hasDirectUnread: true,
        children: [],
      },
    ],
  },
]

function InteractiveTodoInbox({ surface, initialTab = "todo" }: { surface: "desktop" | "mobile"; initialTab?: InboxTab }) {
  const [tab, setTab] = useState<InboxTab>(initialTab)
  const [todos, setTodos] = useState<InboxTodo[]>(createSampleTodos)
  return (
    <div
      className={surface === "desktop"
        ? "w-120 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        : "h-168 w-full max-w-90 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg"}
    >
      <InboxPopover
        surface={surface}
        activeTab={tab}
        onActiveTabChange={setTab}
        unreads={SAMPLE_UNREADS}
        unreadDms={[]}
        mentions={[]}
        todos={todos}
        marked={[]}
        viewerUserId="viewer-1"
        hasProjectedUnreads={true}
        hasProjectedMentions={false}
        onOpenChannel={fn()}
        onMarkChannelRead={fn()}
        onOpenTodo={fn()}
        onDismissTodo={(todo) => {
          setTodos((current) => current.filter((item) => item.messageId !== todo.messageId))
        }}
        onMarkAllRead={fn()}
        onSubmitTodo={async (todo) => {
          setTodos((current) => current.filter((item) => item.messageId !== todo.messageId))
          return { replyToId: todo.messageId }
        }}
      />
    </div>
  )
}

const meta = { title: "Web/Business/Shell details", tags: ["ai-generated"], decorators: [(Story) => <BusinessFixtures><Story /></BusinessFixtures>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const RunningBots: Story = { render: () => <div className="max-w-sm"><ProfileRunningBotsCardView runningBots={[{ id: "demo-alli", name: "Alli", image: "avatar:beam:demo-alli", activityEmoji: "💻", activityText: "Reviewing the project" }]} onOpenBotAudit={fn()} /></div> }
export const UserBarInboxExtension: Story = { render: () => <div className="max-w-sm"><UserBarExtensionSlot active="inbox" inbox={<EmptyInbox />} update={null} eligibleMachines={[]} onDismiss={fn()} onRequestUpdate={fn()} animate={false} /></div> }
export const UserBarUnread: Story = { render: () => <div className="max-w-72 p-4"><UserBar breakpoint="desktop" hasUnread user={{ id: "viewer-1", name: "Gus", avatar: "G", presence: "online" }} inbox={<EmptyInbox />} unreadCount={3} inboxOpen={false} onInboxOpenChange={fn()} onEditProfile={fn()} /></div> }
export const InboxTodoDesktop: Story = { render: () => <div className="p-4"><InteractiveTodoInbox surface="desktop" /></div> }
export const InboxTodoMobile: Story = { render: () => <div className="p-3"><InteractiveTodoInbox surface="mobile" /></div> }
export const InboxUnreadsDesktop: Story = { render: () => <div className="p-4"><InteractiveTodoInbox surface="desktop" initialTab="unreads" /></div> }
export const InboxUnreadsMobile: Story = { render: () => <div className="p-3"><InteractiveTodoInbox surface="mobile" initialTab="unreads" /></div> }
export const ChannelFrame: Story = { render: () => <div className="flex h-128 flex-col"><ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={fn()} /><div className="flex min-h-0 flex-1 flex-col"><MessageListSkeleton /><ComposerPreview /></div></div> }
