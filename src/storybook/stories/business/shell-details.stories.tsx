import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { ProfileRunningBotsCardView } from "@/components/community/social/profile-running-bots-card"
import { UserBarExtensionSlot } from "@/components/community/shell/user-bar-extension-slot"
import { InboxPopover } from "@/components/community/shell/community-inbox-popover"
import { ComposerPreview } from "@/components/community/messages/composer-preview"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { ConversationMessageSkeleton } from "@/components/community/channels/conversation-message-skeleton"

function EmptyInbox() { return <InboxPopover unreads={[]} unreadDms={[]} mentions={[]} marked={[]} hasProjectedUnreads={false} hasProjectedMentions={false} onOpenForumThread={fn()} /> }
const meta = { title: "Web/Business/Shell details", tags: ["ai-generated"], decorators: [(Story) => <BusinessFixtures><Story /></BusinessFixtures>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const RunningBots: Story = { render: () => <div className="max-w-sm"><ProfileRunningBotsCardView runningBots={[{ id: "demo-alli", name: "Alli", image: "avatar:beam:demo-alli", activityEmoji: "💻", activityText: "Reviewing the project" }]} onOpenBotAudit={fn()} /></div> }
export const UserBarInboxExtension: Story = { render: () => <div className="max-w-sm"><UserBarExtensionSlot active="inbox" inbox={<EmptyInbox />} update={null} eligibleMachines={[]} onDismiss={fn()} onRequestUpdate={fn()} animate={false} /></div> }
export const ChannelFrame: Story = { render: () => <div className="flex h-128 flex-col"><ChannelShell header={<ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={fn()} />} body={<div className="flex min-h-0 flex-1 flex-col"><ConversationMessageSkeleton /><ComposerPreview /></div>} /></div> }
