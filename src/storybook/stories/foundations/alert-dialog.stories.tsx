import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogHeader, AlertDialogFooter, AlertDialogAction, AlertDialogCancel, AlertDialogMedia } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

const meta = { title: "Web/Foundations/Alert dialog", component: AlertDialog, tags: ["autodocs", "ai-generated"], args: { onOpenChange: fn() }, render: (args) => <AlertDialog {...args}><AlertDialogTrigger render={<Button variant="destructive" />}>Remove preview item</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogMedia>!</AlertDialogMedia><AlertDialogTitle>Remove this item?</AlertDialogTitle><AlertDialogDescription>This only closes the local example.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> } satisfies Meta<typeof AlertDialog>
export default meta
type Story = StoryObj<typeof meta>
export const Confirm: Story = {}
