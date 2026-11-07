import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { ConversationResolutionPendingFrame } from "@/components/community/channels/conversation-resolution-pending-frame"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { ChannelLoadingFrame } from "@/components/community/channels/channel-loading-frame"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { DmRouteErrorFrame } from "@/components/community/channels/dm-route-error-frame"
import { ServerLandingPendingFrame } from "@/components/community/shell/server-landing-pending-frame"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"

const meta = { title: "Web/Business/Loading and errors", tags: ["autodocs", "ai-generated"], decorators: [(Story) => <BusinessFixtures><div className="flex h-128 flex-col overflow-hidden"><Story /></div></BusinessFixtures>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Resolving: Story = { render: () => <ConversationResolutionPendingFrame /> }
export const TextPending: Story = { render: () => <ConversationResolutionPendingFrame subtype="text" /> }
export const ForumPending: Story = { render: () => <ConversationResolutionPendingFrame subtype="forum" /> }
export const ThreadPending: Story = { render: () => <ConversationResolutionPendingFrame subtype="thread" /> }
export const ConversationError: Story = { render: () => <ConversationResolutionErrorFrame retrying={false} onRetry={fn()} /> }
export const Retrying: Story = { render: () => <ConversationResolutionErrorFrame retrying onRetry={fn()} /> }
export const Channel: Story = { render: () => <ChannelLoadingFrame /> }
export const DirectMessage: Story = { render: () => <DmLoadingFrame /> }
export const DirectMessageError: Story = { render: () => <DmRouteErrorFrame retrying={false} onRetry={fn()} /> }
export const Server: Story = { render: () => <ServerLandingPendingFrame /> }
export const Bots: Story = { render: () => <CommunityPendingFrame href="/c/me/bots" /> }
export const Machines: Story = { render: () => <CommunityPendingFrame href="/c/me/machines" /> }
export const Friends: Story = { render: () => <CommunityPendingFrame href="/c/me/friends" /> }
