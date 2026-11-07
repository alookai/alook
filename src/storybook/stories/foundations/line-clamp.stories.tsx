import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { LineClamp } from "@/components/ui/line-clamp"

const meta = { title: "Web/Foundations/Line clamp", component: LineClamp, tags: ["autodocs", "ai-generated"], args: { text: "A long message should keep the useful beginning visible while its frame stays stable across narrow and wide screens. ".repeat(4), maxLines: 2, location: "end", ellipsis: "…" }, argTypes: { location: { control: "select", options: ["end", "middle"] }, maxLines: { control: { type: "range", min: 1, max: 5, step: 1 } } }, render: (args) => <div className="max-w-md"><LineClamp {...args} /></div> } satisfies Meta<typeof LineClamp>
export default meta
type Story = StoryObj<typeof meta>
export const End: Story = {}
export const Middle: Story = { args: { location: "middle" } }
export const SingleLine: Story = { args: { maxLines: 1 } }
export const Short: Story = { args: { text: "Everything fits." } }
