import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"

const meta = { title: "Web/Foundations/Radio group", component: RadioGroup, tags: ["autodocs", "ai-generated"], args: { defaultValue: "mentions", onValueChange: fn(), "aria-label": "Notification level" }, render: (args) => <RadioGroup {...args}>{[["all", "All messages"], ["mentions", "Only mentions"], ["none", "No notifications"]].map(([value, label]) => <Label key={value}><RadioGroupItem value={value} />{label}</Label>)}</RadioGroup> } satisfies Meta<typeof RadioGroup>
export default meta
type Story = StoryObj<typeof meta>
export const NotificationLevel: Story = {}
export const Disabled: Story = { args: { disabled: true } }
