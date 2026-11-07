import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Textarea } from "@/components/ui/textarea"

const meta = { title: "Web/Foundations/Textarea", component: Textarea, tags: ["autodocs", "ai-generated"], args: { "aria-label": "Description", placeholder: "Describe the channel", onChange: fn() } } satisfies Meta<typeof Textarea>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
export const LongContent: Story = { args: { defaultValue: "A shared space for people and agents. ".repeat(16) } }
export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "Needs correction" } }
export const Disabled: Story = { args: { disabled: true } }
