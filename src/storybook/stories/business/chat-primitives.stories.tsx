import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { MessageBubble } from "@/components/chat-primitives/message-bubble"
import { MessageCluster } from "@/components/chat-primitives/message-cluster"
import { AgentAvatar } from "@/components/avatar/agent-avatar"

const meta = { title: "Web/Business/Message bubbles", component: MessageBubble, tags: ["autodocs", "ai-generated"], args: { variant: "agent", position: "single", children: "Ready for your next task." }, argTypes: { variant: { control: "select", options: ["agent", "user"] }, position: { control: "select", options: ["first", "middle", "last", "single"] } } } satisfies Meta<typeof MessageBubble>
export default meta
type Story = StoryObj<typeof meta>
export const Agent: Story = {}
export const User: Story = { args: { variant: "user", children: "Please review the latest changes." } }
export const Cluster: Story = { render: () => <div className="max-w-lg"><MessageCluster avatar={<AgentAvatar seed="demo-alli" name="Alli" size={30} />} name="Alli" position="solo"><MessageBubble variant="agent" position="first">I read the brief.</MessageBubble><MessageBubble variant="agent" position="last">There are two open questions.</MessageBubble></MessageCluster></div> }
