import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Switch } from "@/components/ui/switch"

const meta = { title: "Web/Foundations/Switch", component: Switch, tags: ["autodocs", "ai-generated"], args: { "aria-label": "Show notifications", defaultChecked: false, disabled: false, size: "default", onCheckedChange: fn() }, argTypes: { size: { control: "select", options: ["default", "sm"] } } } satisfies Meta<typeof Switch>
export default meta
type Story = StoryObj<typeof meta>
export const Off: Story = {}
export const On: Story = { args: { defaultChecked: true } }
export const Small: Story = { args: { size: "sm" } }
export const Disabled: Story = { args: { defaultChecked: true, disabled: true } }
