import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { fn } from "storybook/test"
import { Fixtures } from "../../../web/src/app/brand-visual/app-components"
import { MessageList } from "../../../web/src/components/community/messages/message-list"
import { MessageRendererSettings } from "../../../web/src/components/community/settings/message-renderer-settings"
import { CommunityPreviewNavigation } from "../../../web/src/components/community/shell/community-preview-navigation"
import { Button } from "../../../web/src/components/ui/button"
import type { MessageRequest } from "../../../web/src/lib/community/message-position"
import { applyMessageReaction, type Msg } from "../../../web/src/lib/community/models/message"
import { trialMessage, trialPage, TRIAL_EVENT_SEQUENCE } from "../../preview/message-renderer-trial/real-message-fixtures"

const action = fn()
function initial() { return { messages: trialPage(60, 40), start: 60, next: 100, window: {}, generation: 0 } }
function Trial() {
  const [state, setState] = useState(initial)
  const loadOlder = (): MessageRequest => {
    if (state.start === 0) return { accepted: false }
    const window = {}
    const start = Math.max(0, state.start - 20)
    setState(current => ({ ...current, start, window, messages: [...trialPage(start, current.start - start), ...current.messages] }))
    action("older", start)
    return { accepted: true, completed: Promise.resolve({ status: "success", window }) }
  }
  const append = (authorId: string) => setState(current => ({ ...current, next: current.next + 1, messages: [...current.messages, trialMessage(current.next, authorId)] }))
  return <Fixtures accountId="demo-gus"><CommunityPreviewNavigation value={true}>
    <div className="flex min-w-0 flex-col gap-4">
      <MessageRendererSettings accountId="demo-gus" />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setState(current => ({ ...initial(), generation: current.generation + 1 }))}>Reset fixture</Button>
        <Button variant="outline" size="sm" onClick={() => append("demo-alli")}>Append peer fixture</Button>
        <Button variant="outline" size="sm" onClick={() => append("demo-gus")}>Append local fixture</Button>
      </div>
      <div className="relative flex h-130 min-h-0 flex-col overflow-hidden rounded-lg border border-border">
        <MessageList key={state.generation} channel="renderer-trial" messages={state.messages} messageWindow={state.window} viewerUserId="demo-gus" hasMore={state.start > 0} historyStartKnown={state.start === 0} onLoadOlder={loadOlder} onOpenThread={action} onOpenProfile={action} onReply={action} onCopy={action} onMark={action} onReact={action} onToggleReaction={action} onRetry={action} onDismiss={action} onReadingMessage={action} resolveAuthorMentionText={id => id === "demo-gus" ? "@Gus" : "@Alli"} onInsertMentionText={action} />
      </div>
      <p className="text-xs text-muted-foreground">Same fixture sequence: {TRIAL_EVENT_SEQUENCE.join(" → ")}. This auxiliary preview records local actions. Use the trial application for Advanced/reload, composer, permissions, real read receipts and newer-window checks.</p>
    </div>
  </CommunityPreviewNavigation></Fixtures>
}
const meta = { title: "Web/Business/Message renderer trial", tags: ["ai-generated"], parameters: { layout: "padded", docs: { description: { component: "One original MessageList, real local preference control, canonical Message actions and identical typed fixtures. Candidate loading and runtime errors remain visible. This story is auxiliary to the actual application trial." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Comparison: Story = { render: () => <Trial /> }

function updateMessage(index: number, content: string, authorId: string): Msg {
  return { ...trialMessage(index * 10, authorId), seq: index + 1, content }
}

const previewText = "The preview is ready.\n\nThe caption is already reviewed."

function initialUpdates() {
  return [
    updateMessage(0, "Can you check the new preview?", "demo-alli"),
    { ...updateMessage(1, previewText, "demo-gus"), reactions: [{ emoji: "👀", count: 1, me: false, userIds: ["demo-alli"] }] },
  ]
}

const receiptNonce = "renderer-trial-send"

function UpdatesTrial() {
  const [messages, setMessages] = useState(initialUpdates)
  const [generation, setGeneration] = useState(0)
  const canReceive = !messages.some(message => message.id === "renderer-trial-20")
  const canSend = !messages.some(message => message.clientNonce === receiptNonce)
  const canConfirm = messages.some(message => message.id === "renderer-trial-local")
  const react = (id: string, emoji: string, toggle = false) => {
    setMessages(current => current.map(message => {
      if (message.id !== id) return message
      const add = !toggle || !message.reactions?.some(reaction => reaction.emoji === emoji && reaction.me)
      return { ...message, reactions: applyMessageReaction(message.reactions, emoji, "demo-gus", add, "demo-gus") }
    }))
  }
  return <Fixtures accountId="demo-gus">
    <div className="flex min-w-0 flex-col gap-4">
      <MessageRendererSettings accountId="demo-gus" />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => { setMessages(initialUpdates()); setGeneration(current => current + 1) }}>Reset conversation</Button>
        <Button variant="outline" size="sm" disabled={!canReceive} onClick={() => {
          setMessages(current => {
            const pending = current.find(message => message.seq === undefined)
            const confirmed = current.filter(message => message.seq !== undefined)
            const peer = { ...updateMessage(2, "I’ll review the layout now.", "demo-alli"), seq: (confirmed.at(-1)?.seq ?? 0) + 1 }
            return [...confirmed, peer, ...(pending ? [pending] : [])]
          })
        }}>Receive message</Button>
        <Button variant="outline" size="sm" disabled={!canSend} onClick={() => {
          setMessages(current => [...current, { ...updateMessage(3, "Thanks. I sent the sample.", "demo-gus"),
            id: "renderer-trial-local", seq: undefined, clientNonce: receiptNonce }])
        }}>Send local message</Button>
        <Button variant="outline" size="sm" disabled={!canConfirm} onClick={() => {
          setMessages(current => {
            const sequence = (current.at(-2)?.seq ?? 0) + 1
            return current.map(message => message.id === "renderer-trial-local"
              ? { ...message, id: "renderer-trial-confirmed", seq: sequence }
              : message)
          })
        }}>Confirm send</Button>
      </div>
      <div className="relative flex h-100 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
        <MessageList key={generation} channel="Message updates" messages={messages} viewerUserId="demo-gus" onOpenThread={action} onReact={react} onToggleReaction={(id, emoji) => react(id, emoji, true)} />
      </div>
    </div>
  </Fixtures>
}

export const Updates: Story = { render: () => <UpdatesTrial /> }
