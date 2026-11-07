import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { MockNetworkPill } from "@/components/mock-network-pill"

const meta = { title: "Web/Business/Development diagnostic", component: MockNetworkPill, tags: ["ai-generated"], parameters: { docs: { description: { component: "The actual draggable diagnostic view. This appearance example does not enable the application's global mock-network delay flag or claim that Storybook requests are delayed by the displayed amount." } } } } satisfies Meta<typeof MockNetworkPill>
export default meta
type Story = StoryObj<typeof meta>
export const Draggable: Story = {}
