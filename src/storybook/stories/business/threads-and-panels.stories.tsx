import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { useState } from "react"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { ThreadSplitView } from "@/components/community/channels/thread-split-view"
import { ThreadPanelActions } from "@/components/community/channels/thread-panel-actions"
import { ConversationResolutionPendingFrame } from "@/components/community/channels/conversation-resolution-pending-frame"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import { PostTagDialog } from "@/components/community/channels/post-tag-dialog"
import { Button } from "@/components/ui/button"

function PanelExample({ kind = "members" }: { kind?: "members" | "pinned" | "threads" }) { const [open, setOpen] = useState(false); return <><Button onClick={() => setOpen(true)}>Open {kind}</Button><CommunityPanel open={open} onOpenChange={setOpen} kind={kind} members={[]} pinned={[]} threads={[]} onOpenProfile={fn()} onOpenThread={fn()} /></> }
const meta = { title: "Web/Business/Threads and panels", tags: ["ai-generated"], decorators: [(Story) => <BusinessFixtures><Story /></BusinessFixtures>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const ParallelThreads: Story = { render: () => <div className="h-160"><ThreadSplitView split parent={<div className="flex h-full flex-col"><ConversationResolutionPendingFrame subtype="text" /></div>} thread={<div className="flex h-full flex-col"><ThreadPanelActions onFullscreen={fn()} onClose={fn()} /><ConversationResolutionPendingFrame subtype="thread" /></div>} /></div> }
export const ResolvingParent: Story = { render: () => <div className="h-160"><ThreadSplitView split resolvingParent parent={null} thread={<ConversationResolutionPendingFrame subtype="thread" />} /></div> }
export const Members: Story = { render: () => <PanelExample /> }
export const Pins: Story = { render: () => <PanelExample kind="pinned" /> }
export const Threads: Story = { render: () => <PanelExample kind="threads" /> }
export const PostTags: Story = { render: () => <PostTagDialog trigger={<Button variant="outline">Edit tags</Button>} postName="Design review" current={["design"]} allTags={["design", "bug", "ready", "archived"]} onSave={fn()} /> }
