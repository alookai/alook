import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription, SheetHeader, SheetFooter, SheetClose } from "@/components/ui/sheet"
import { SheetResizeHandle, useSheetResize } from "@/components/ui/sheet-resize-handle"
import { Button } from "@/components/ui/button"

function SheetExample({ side = "right" }: { side?: "top" | "right" | "bottom" | "left" }) { const [open, setOpen] = useState(false); const { width, ...resize } = useSheetResize(); return <Sheet open={open} onOpenChange={setOpen}><SheetTrigger render={<Button />}>Open sheet</SheetTrigger><SheetContent side={side} style={side === "right" ? { width, maxWidth: "100%" } : undefined}>{side === "right" && <SheetResizeHandle {...resize} />}<SheetHeader><SheetTitle>Details</SheetTitle><SheetDescription>Resize or dismiss this real product sheet.</SheetDescription></SheetHeader><div className="flex-1 p-4">The swipe container and portal belong to the actual Sheet component.</div><SheetFooter><SheetClose render={<Button variant="outline" />}>Close</SheetClose></SheetFooter></SheetContent></Sheet> }
const meta = { title: "Web/Foundations/Sheet", component: SheetExample, tags: ["autodocs", "ai-generated"], args: { side: "right" }, argTypes: { side: { control: "select", options: ["top", "right", "bottom", "left"] } } } satisfies Meta<typeof SheetExample>
export default meta
type Story = StoryObj<typeof meta>
export const Right: Story = {}
export const Bottom: Story = { args: { side: "bottom" } }
