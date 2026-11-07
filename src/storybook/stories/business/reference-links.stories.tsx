import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { ChannelRefPill } from "@/components/community/messages/channel-ref-pill"
import { ServerRefPill } from "@/components/community/messages/server-ref-pill"
import { AccountFixtures } from "../../preview/business-fixtures"

const meta = { title: "Web/Business/Reference links", tags: ["ai-generated"], decorators: [(Story) => <AccountFixtures><div className="flex flex-wrap gap-4"><Story /></div></AccountFixtures>], parameters: { docs: { description: { component: "Original channel/server resolvers with a local read-only directory and target fixture. The missing channel uses an actual 404. Navigation requires an application shell and is not claimed by this isolated example." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Channel: Story = { render: () => <ChannelRefPill>/Studio#4012/general</ChannelRefPill> }
export const Server: Story = { render: () => <ServerRefPill>/Studio#4012</ServerRefPill> }
export const MissingChannel: Story = { render: () => <ChannelRefPill>/Studio#4012/unknown</ChannelRefPill> }
