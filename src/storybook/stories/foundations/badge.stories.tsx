import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Badge } from "@/components/ui/badge"

const meta = { title: "Web/Foundations/Badge", component: Badge, tags: ["autodocs", "ai-generated"], args: { children: "Ready", variant: "default" }, argTypes: { variant: { control: "select", options: ["default", "secondary", "destructive", "outline", "ghost", "link"] }, children: { control: "text" } } } satisfies Meta<typeof Badge>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Secondary: Story = { args: { variant: "secondary" } }
export const Destructive: Story = { args: { variant: "destructive", children: "Failed" } }
export const Outline: Story = { args: { variant: "outline" } }
export const LongLabel: Story = { args: { children: "Waiting for the machine to reconnect" } }
