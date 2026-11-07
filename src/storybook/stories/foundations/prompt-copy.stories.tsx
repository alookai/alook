import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { PromptCopyPreview } from "@/components/ui/prompt-copy-preview"

const meta = { title: "Web/Foundations/Prompt copy preview", component: PromptCopyPreview, tags: ["autodocs", "ai-generated"], args: { label: "Agent instructions", value: "Read the project brief, then summarize the open questions.\nKeep the answer brief.", copied: false, onCopy: fn() } } satisfies Meta<typeof PromptCopyPreview>
export default meta
type Story = StoryObj<typeof meta>
export const Ready: Story = {}
export const Copied: Story = { args: { copied: true } }
export const LongContent: Story = { args: { value: "Long instructions must remain selectable and stay inside the preview. ".repeat(12) } }
