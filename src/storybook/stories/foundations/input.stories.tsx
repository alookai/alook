import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Input } from "@/components/ui/input"

const meta = { title: "Web/Foundations/Input", component: Input, tags: ["autodocs", "ai-generated"], args: { "aria-label": "Channel name", placeholder: "general", onChange: fn(), disabled: false }, argTypes: { type: { control: "select", options: ["text", "email", "password", "search", "number"] } } } satisfies Meta<typeof Input>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
export const Filled: Story = { args: { defaultValue: "design-review" } }
export const Disabled: Story = { args: { disabled: true, defaultValue: "read-only-channel" } }
export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "already-used" } }
export const LongValue: Story = { args: { defaultValue: "a-very-long-channel-name-that-must-stay-within-the-input" } }
