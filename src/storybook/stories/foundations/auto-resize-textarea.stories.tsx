import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"

const meta = { title: "Web/Foundations/Auto resize textarea", component: AutoResizeTextarea, tags: ["autodocs", "ai-generated"], args: { "aria-label": "Message", placeholder: "Write a message", className: "w-full rounded-md border border-input p-3", onChange: fn() } } satisfies Meta<typeof AutoResizeTextarea>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
export const MultipleLines: Story = { args: { defaultValue: "First line\nSecond line\nThird line" } }
export const Disabled: Story = { args: { disabled: true, defaultValue: "Sending is unavailable." } }
