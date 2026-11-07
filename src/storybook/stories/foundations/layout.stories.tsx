import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { AppBackground, AppSurface, AppRail } from "@/components/ui/app-surface"
import { AppEdgeFade } from "@/components/ui/app-edge-fade"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Kbd, KbdGroup } from "@/components/ui/kbd"

function Surface() { return <div className="relative isolate flex h-80 gap-2"><AppBackground /><AppRail><Kbd>A</Kbd><Kbd>B</Kbd></AppRail><AppSurface><div className="relative flex flex-1 flex-col gap-4 overflow-auto p-4 thin-scrollbar"><h2>Conversation</h2><Separator /><div className="flex gap-3"><Skeleton className="size-10 rounded-full" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-2/3" /></div></div><Separator /><KbdGroup><Kbd>⌘</Kbd><Kbd>K</Kbd></KbdGroup><AppEdgeFade /></div></AppSurface></div> }
const meta = { title: "Web/Foundations/Surface and loading", component: Surface, tags: ["autodocs", "ai-generated"] } satisfies Meta<typeof Surface>
export default meta
type Story = StoryObj<typeof meta>
export const Shell: Story = {}
