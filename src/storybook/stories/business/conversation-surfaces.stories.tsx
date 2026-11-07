import type { ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { fn } from "storybook/test"
import { PreviewCommunityShell } from "../../preview/community-shell"
import { TextChannelSurface } from "@/components/community/channels/text-channel-surface"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { ThreadChannelSurface } from "@/components/community/channels/thread-channel-surface"
import { fixtureMessages } from "../../preview/read-fixtures"

const viewer = { id: "demo-gus", name: "Gus", discriminator: "1813", avatar: "/landing/people/lin.webp" }
const resolveUserName = (id: string) => id === "demo-gus" ? "Gus" : id === "demo-alli" ? "Alli" : id
const shared: Pick<ComponentProps<typeof TextChannelSurface>, "serverId" | "serverParam" | "viewer" | "notificationLevel" | "onSetNotificationLevel" | "composerMembers" | "composerMentionCandidates" | "memberPanelProps" | "manageMembersDialog" | "onOpenProfile"> = { serverId: "demo-studio", serverParam: "demo-studio", viewer, notificationLevel: USE_SERVER_DEFAULT, onSetNotificationLevel: fn(), composerMembers: [], composerMentionCandidates: undefined, memberPanelProps: { members: [] }, manageMembersDialog: null, onOpenProfile: fn() }
const meta = { title: "Web/Business/Conversation surfaces", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Actual channel, forum and thread controllers backed by local schema-qualified read fixtures. Send/create/manage commands are intentionally unprovided and return explicit errors; use the separate homepage demo for local accepted-send interactions." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const TextChannel: Story = { parameters: { nextjs: { navigation: { pathname: "/c/channels/demo-studio/demo-general" } } }, render: () => <PreviewCommunityShell href="/c/channels/demo-studio/demo-general"><TextChannelSurface {...shared} channelId="demo-general" channelName="general" canManagePins={false} anchorMessageId={null} channelRefCandidates={undefined} uiHandlers={{}} onOpenThread={fn()} resolveUserName={resolveUserName} /></PreviewCommunityShell> }
export const Forum: Story = { parameters: { nextjs: { navigation: { pathname: "/c/channels/demo-studio/storybook-forum" } } }, render: () => <PreviewCommunityShell href="/c/channels/demo-studio/storybook-forum"><ForumChannelSurface {...shared} channelId="storybook-forum" channelName="Ideas" viewerRole="owner" onOpenPost={fn()} /></PreviewCommunityShell> }
export const Thread: Story = { parameters: { nextjs: { navigation: { pathname: "/c/channels/demo-studio/storybook-thread" } } }, render: () => <PreviewCommunityShell href="/c/channels/demo-studio/storybook-thread"><ThreadChannelSurface {...shared} channelId="storybook-thread" channelName="Project review" canManagePins={false} anchorMessageId={null} parentChannelId="demo-general" parentMessageId={fixtureMessages[0]!.id} parentIsForum={false} canRenameThread={false} onNavigateParent={fn()} channelRefCandidates={undefined} uiHandlers={{}} onOpenChild={fn()} resolveUserName={resolveUserName} /></PreviewCommunityShell> }
