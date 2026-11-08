import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { PresenceLine } from "@/components/agent-chat/presence-line"
import { PresenceStatus } from "@/components/community/presence-status"
import { OfficialServerBadge } from "@/components/community/official-server-badge"

const meta = { title: "Web/Business/Presence", component: PresenceLine, tags: ["autodocs", "ai-generated"], args: { agentFirstName: "Alli" } } satisfies Meta<typeof PresenceLine>
export default meta
type Story = StoryObj<typeof meta>
export const Typing: Story = {}
export const StatusPills: Story = { render: () => <div className="flex flex-wrap gap-3"><PresenceStatus online label="Online" /><PresenceStatus online={false} label="Offline" /><PresenceStatus online={false} known={false} label="Unknown" /><OfficialServerBadge official /></div> }
