import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const meta = { title: "Web/Foundations/Dialog", component: Dialog, tags: ["autodocs", "ai-generated"], args: { onOpenChange: fn() }, render: (args) => <Dialog {...args}><DialogTrigger render={<Button />}>Open dialog</DialogTrigger><DialogContent><DialogHeader><DialogTitle>Edit channel</DialogTitle><DialogDescription>Changes stay inside this local preview.</DialogDescription></DialogHeader><Input aria-label="Channel name" defaultValue="general" /><DialogFooter><DialogClose render={<Button variant="outline" />}>Cancel</DialogClose><DialogClose render={<Button />}>Done</DialogClose></DialogFooter></DialogContent></Dialog> } satisfies Meta<typeof Dialog>
export default meta
type Story = StoryObj<typeof meta>
export const OpenAndClose: Story = {}
