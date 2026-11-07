import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverClose } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"

const meta = { title: "Web/Foundations/Popover", component: Popover, tags: ["autodocs", "ai-generated"], render: (args) => <Popover {...args}><PopoverTrigger render={<Button variant="outline" />}>Open details</PopoverTrigger><PopoverContent><PopoverTitle>Channel details</PopoverTitle><p className="py-3 text-sm">A local popover with a real portal and dismiss behavior.</p><PopoverClose render={<Button size="sm" />}>Close</PopoverClose></PopoverContent></Popover> } satisfies Meta<typeof Popover>
export default meta
type Story = StoryObj<typeof meta>
export const Details: Story = {}
