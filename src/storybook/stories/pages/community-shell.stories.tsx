import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { PreviewCommunityShell } from "../../preview/community-shell"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"

const meta = { title: "Web/Pages/Community shell", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Original shell and module owners on a local demo-account fixture. Explicit local read fixtures expose empty account modules; unprovided requests remain errors. Loaded business appearances are separately available in Product compositions. Next navigation is the official framework mock; no authenticated Web bootstrap, socket transport or real account writes is mounted." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const BotsEmpty: Story = { parameters: { nextjs: { navigation: { pathname: "/c/me/bots" } } }, render: () => <PreviewCommunityShell href="/c/me/bots" /> }
export const MachinesEmpty: Story = { parameters: { nextjs: { navigation: { pathname: "/c/me/machines" } } }, render: () => <PreviewCommunityShell href="/c/me/machines" /> }
export const FriendsEmpty: Story = { parameters: { nextjs: { navigation: { pathname: "/c/me/friends" } } }, render: () => <PreviewCommunityShell href="/c/me/friends" /> }
export const PrivacyEmpty: Story = { parameters: { nextjs: { navigation: { pathname: "/c/me/privacy" } } }, render: () => <PreviewCommunityShell href="/c/me/privacy" /> }
export const PendingSession: Story = { render: () => <BusinessFixtures><CommunitySessionPendingFrame pathname="/c/me/bots" /></BusinessFixtures> }
export const ServerConversation: Story = { parameters: { nextjs: { navigation: { pathname: "/c/channels/demo-studio/demo-general" } } }, render: () => <PreviewCommunityShell href="/c/channels/demo-studio/demo-general" /> }
export const DirectMessage: Story = { parameters: { nextjs: { navigation: { pathname: "/c/me/storybook-dm" } } }, render: () => <PreviewCommunityShell href="/c/me/storybook-dm" /> }
export const ServerThread: Story = { parameters: { nextjs: { navigation: { pathname: "/c/channels/demo-studio/storybook-thread" } } }, render: () => <PreviewCommunityShell href="/c/channels/demo-studio/storybook-thread" /> }
export const MessageResolutionUnavailable: Story = { parameters: { nextjs: { navigation: { pathname: "/c/messages/storybook-unavailable" } } }, render: () => <PreviewCommunityShell href="/c/messages/storybook-unavailable" /> }
