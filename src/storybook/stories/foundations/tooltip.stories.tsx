import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

function TooltipExample({ text = "Open the channel list" }: { text?: string }) { return <Tooltip><TooltipTrigger render={<Button variant="outline" />}>Hover or focus</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip> }
const meta = { title: "Web/Foundations/Tooltip", component: TooltipExample, tags: ["autodocs", "ai-generated"], args: { text: "Open the channel list" } } satisfies Meta<typeof TooltipExample>
export default meta
type Story = StoryObj<typeof meta>
export const Hint: Story = {}
export const LongHint: Story = { args: { text: "This hint explains the action while preserving keyboard focus and the portal boundary." } }
