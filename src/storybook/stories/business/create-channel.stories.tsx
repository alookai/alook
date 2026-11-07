import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Button } from "../../../web/src/components/ui/button"
import { CreateChannelDialog } from "../../../web/src/components/community/settings/create-channel-dialog"

function CreateChannelExample({ category, onCreate }: { category: string; onCreate: (value: { name: string; type: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState("")
  return <div className="space-y-4 p-6">
    <Button onClick={() => setOpen(true)}>Open New channel</Button>
    <output aria-live="polite" className="block text-sm text-muted-foreground">{created || "The form creates preview data only."}</output>
    {open && <CreateChannelDialog category={category} onClose={() => setOpen(false)} onCreate={(value) => { onCreate(value); setCreated(`Created ${value.type} channel: ${value.name}`) }} />}
  </div>
}

const meta = {
  title: "Web/Business/Create channel",
  component: CreateChannelExample,
  tags: ["autodocs", "ai-generated"],
  args: { category: "Product", onCreate: fn() },
  argTypes: { category: { control: "text" } },
  parameters: { layout: "fullscreen", docs: { description: { component: "The existing CreateChannelDialog, including its name input, slug preview, Text/Forum choice, validation and portal. Submission updates only this story's local result." } } },
} satisfies Meta<typeof CreateChannelExample>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {}
