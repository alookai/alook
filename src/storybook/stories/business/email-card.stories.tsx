import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { EmailCard } from "@/components/agent-chat/event-cards/email-card"

const meta = { title: "Web/Business/Email card", component: EmailCard, tags: ["autodocs", "ai-generated"], args: { subject: "Project review", address: "team@example.com", direction: "inbound" }, argTypes: { direction: { control: "select", options: ["inbound", "outbound"] } } } satisfies Meta<typeof EmailCard>
export default meta
type Story = StoryObj<typeof meta>
export const Inbound: Story = {}
export const Outbound: Story = { args: { direction: "outbound" } }
export const LongSubject: Story = { args: { subject: "A detailed review of the current project plan and the remaining questions before delivery" } }
