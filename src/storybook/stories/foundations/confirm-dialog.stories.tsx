import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Button } from "@/components/ui/button"

function ConfirmExample(props: Omit<React.ComponentProps<typeof ConfirmDialog>, "open" | "onOpenChange">) { const [open, setOpen] = useState(false); return <><Button variant="destructive" onClick={() => setOpen(true)}>Open confirmation</Button><ConfirmDialog {...props} open={open} onOpenChange={setOpen} /></> }
const meta = { title: "Web/Foundations/Confirm dialog", component: ConfirmExample, tags: ["autodocs", "ai-generated"], args: { title: "Remove member?", description: "Review the action before you continue.", confirmLabel: "Remove", loading: false, onConfirm: fn() } } satisfies Meta<typeof ConfirmExample>
export default meta
type Story = StoryObj<typeof meta>
export const Ready: Story = {}
export const Loading: Story = { args: { loading: true } }
