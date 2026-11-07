import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { InviteDialog } from "@/components/community/social/invite-dialog"
import { Button } from "@/components/ui/button"
import { AccountFixtures } from "../../preview/business-fixtures"
import { fixtureServerId } from "../../preview/read-fixtures"

function InviteExample({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return <AccountFixtures><Button onClick={() => { setOpen(true); onOpenChange(true) }}>Open invite dialog</Button><InviteDialog open={open} onOpenChange={(value) => { setOpen(value); onOpenChange(value) }} serverId={fixtureServerId} serverName="Preview studio" /></AccountFixtures>
}

const meta = {
  title: "Web/Business/Invite dialog",
  component: InviteExample,
  tags: ["autodocs", "ai-generated"],
  args: { onOpenChange: fn() },
  parameters: { docs: { description: { component: "Original dialog with a viewer-owned, read-only local invite fixture and an empty friends list. The displayed storybook-local-invite code is a fake example; it cannot invite people. Creation, revocation and sending commands remain unprovided and report errors if requested." } } },
} satisfies Meta<typeof InviteExample>
export default meta
type Story = StoryObj<typeof meta>
export const ExistingLocalInvite: Story = {}
