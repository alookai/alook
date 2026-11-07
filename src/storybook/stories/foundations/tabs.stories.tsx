import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

function ChannelTabs({ variant = "default", orientation = "horizontal", onValueChange }: { variant?: "default" | "line"; orientation?: "horizontal" | "vertical"; onValueChange?: (value: unknown) => void }) { return <Tabs defaultValue="messages" orientation={orientation} onValueChange={onValueChange}><TabsList variant={variant}><TabsTrigger value="messages">Messages</TabsTrigger><TabsTrigger value="members">Members</TabsTrigger><TabsTrigger value="disabled" disabled>Unavailable</TabsTrigger></TabsList><TabsContent value="messages">Conversation content</TabsContent><TabsContent value="members">Channel members</TabsContent></Tabs> }
const meta = { title: "Web/Foundations/Tabs", component: ChannelTabs, tags: ["autodocs", "ai-generated"], args: { variant: "default", orientation: "horizontal", onValueChange: fn() }, argTypes: { variant: { control: "select", options: ["default", "line"] }, orientation: { control: "select", options: ["horizontal", "vertical"] } } } satisfies Meta<typeof ChannelTabs>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Line: Story = { args: { variant: "line" } }
export const Vertical: Story = { args: { orientation: "vertical" } }
