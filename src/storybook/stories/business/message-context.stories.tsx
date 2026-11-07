import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { AccountFixtures } from "../../preview/business-fixtures"
import { fixtureMessages } from "../../preview/read-fixtures"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageShareDialog } from "@/components/community/messages/message-share-dialog"
import { ThreadOpener } from "@/components/community/messages/thread-opener"
import { presentCanonicalMessage } from "@/lib/community/message-wire"
import { BotPiiChatAction } from "@/components/community/bots/bot-pii-chat-action"
import { Button } from "@/components/ui/button"

function ContextExample() { const [open, setOpen] = useState(false); const metadata = useChannelMetadata("demo-studio", "demo-general"); return <><Button disabled={!metadata.canRead} onClick={() => setOpen(true)}>Open message context</Button><MessageContextSheet open={open} onOpenChange={setOpen} channelId="demo-general" serverId="demo-studio" channelLabel="general" targetSeq={1} onReply={fn()} /></> }
function ShareExample() { const [open, setOpen] = useState(false); return <><Button onClick={() => setOpen(true)}>Open share card</Button><MessageShareDialog m={{ ...presentCanonicalMessage(fixtureMessages[0]!), grouped: false }} open={open} onClose={() => setOpen(false)} /></> }
const meta = { title: "Web/Business/Message tools", tags: ["ai-generated"], decorators: [(Story) => <AccountFixtures><Story /></AccountFixtures>], parameters: { docs: { description: { component: "Original context, opener and share components under the actual demo account owner. A callback or rendered preview is not proof of clipboard, OS save or real server command success." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Context: Story = { render: () => <ContextExample /> }
export const ThreadParent: Story = { render: () => <ThreadOpener parentMessageId={fixtureMessages[0]!.id} parentChannelId="demo-general" serverId="demo-studio" viewerUserId="demo-gus" onJump={fn()} /> }
export const ShareCard: Story = { render: () => <ShareExample /> }
export const FilterAssistance: Story = { render: () => <BotPiiChatAction botId="demo-alli" /> }
