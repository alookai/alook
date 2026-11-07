import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator } from "@/components/ui/select"

function ChannelSelect({ disabled = false, placeholder = "Choose a channel", onValueChange }: { disabled?: boolean; placeholder?: string; onValueChange?: (value: string | null) => void }) {
  return <Select disabled={disabled} onValueChange={onValueChange}><SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Channels</SelectLabel><SelectItem value="general">General</SelectItem><SelectItem value="design">Design review</SelectItem><SelectItem value="archive" disabled>Archive (read only)</SelectItem></SelectGroup><SelectSeparator /><SelectItem value="help">Help and support</SelectItem></SelectContent></Select>
}
const meta = { title: "Web/Foundations/Select", component: ChannelSelect, tags: ["autodocs", "ai-generated"], args: { disabled: false, placeholder: "Choose a channel", onValueChange: fn() } } satisfies Meta<typeof ChannelSelect>
export default meta
type Story = StoryObj<typeof meta>
export const Choose: Story = {}
export const Disabled: Story = { args: { disabled: true } }
export const LongPlaceholder: Story = { args: { placeholder: "Choose a channel for the full project discussion" } }
