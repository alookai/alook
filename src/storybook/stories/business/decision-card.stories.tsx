import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { DecisionCardInputSchema, buildDecisionCardEmbed } from "@alook/shared"
import { Fixtures } from "../../../web/src/app/brand-visual/app-components"
import { ChannelHeader } from "../../../web/src/components/community/channels/channel-header"
import { DateDivider } from "../../../web/src/components/community/dividers"
import { Composer } from "../../../web/src/components/community/messages/composer"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "../../../web/src/components/community/messages/conversation-footer-shell"
import { DecisionCard } from "../../../web/src/components/community/messages/decision-card"
import { Message } from "../../../web/src/components/community/messages/message"
import { DEMO_MESSAGES, DEMO_PROFILES } from "../../../web/src/components/home/landing-interactive-shell-data"
import type { Msg } from "../../../web/src/lib/community/models/message"
import type { Member } from "../../../web/src/lib/community/models/people"

const interactiveCard = buildDecisionCardEmbed(
  DecisionCardInputSchema.parse({
    summary: "Confirm rollout timing and platforms",
    questions: [
      {
        id: "timing",
        header: "Timing",
        question: "When should we publish the draft?",
        options: [
          { id: "today", label: "Today", description: "Publish in this release.", recommended: true },
          { id: "next_week", label: "Next week", description: "Wait for the next release." },
        ],
      },
      {
        id: "platforms",
        header: "Targets",
        question: "Which surfaces need QA first?",
        multiSelect: true,
        options: [
          { id: "web", label: "Web" },
          { id: "desktop", label: "Desktop" },
          { id: "mobile", label: "Mobile" },
        ],
      },
    ],
  }),
  [{ userId: "demo-gus", handle: "gus#1813" }],
)

const STREAM_MESSAGES = (DEMO_MESSAGES["demo-general"] ?? []).slice(0, 2)
const STREAM_MEMBERS: Member[] = [...DEMO_PROFILES.values()].map((p) => ({
  id: p.id,
  userId: p.id,
  name: p.name!,
  avatar: p.avatar!,
  avatarVersion: 0,
  discriminator: p.discriminator ?? "",
  status: p.presence ?? "online",
  sub: p.aboutMe ?? "",
  role: p.id === "demo-gus" ? "owner" : "member",
}))
const DECISION_STREAM_MSG: Msg & { grouped: boolean } = {
  id: "demo-decision-msg",
  type: "chat",
  grouped: false,
  authorId: "demo-alli",
  authorName: "Alli",
  createdAt: "2026-11-20T10:42:00.000Z",
  content: "@gus#1813 Confirm rollout timing and platforms",
  decisionCard: interactiveCard,
}

const meta = {
  title: "Web/Business/DecisionCard",
  component: DecisionCard,
  tags: ["autodocs", "ai-generated"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component: "Interactive decision card rendered inside community messages when a bot asks structured questions via `alook message send --ask`.",
      },
    },
  },
  decorators: [(Story) => <Fixtures><div className="mx-auto max-w-2xl"><Story /></div></Fixtures>],
  args: {
    card: interactiveCard,
    messageId: "demo-decision-1",
    viewerUserId: "demo-gus",
    onSubmit: async (messageId) => ({ replyToId: messageId }),
  },
} satisfies Meta<typeof DecisionCard>

export default meta
type Story = StoryObj<typeof meta>

export const Interactive: Story = {}
export const ReadOnlyOtherViewer: Story = {
  args: {
    viewerUserId: "demo-other",
  },
}

export const InMessageStream: Story = {
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <Fixtures><Story /></Fixtures>],
  render: () => (
    <div
      data-slot="community-conversation-surface"
      className="mx-auto flex h-[860px] max-w-3xl flex-col overflow-hidden border-x border-border bg-background"
    >
      <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={() => {}} />
      <div className="flex-1 overflow-y-auto px-2 py-2 thin-scrollbar">
        <DateDivider label="Nov 20, 2026" />
        {STREAM_MESSAGES.map((m) => (
          <Message key={m.id} m={{ ...m, grouped: false }} onOpenThread={() => {}} onReply={() => {}} onCopy={() => {}} />
        ))}
        <Message
          m={DECISION_STREAM_MSG}
          viewerUserId="demo-gus"
          onSubmitDecisionCard={async (messageId) => ({ replyToId: messageId })}
          onOpenThread={() => {}}
          onReply={() => {}}
          onCopy={() => {}}
        />
      </div>
      <ConversationFooterSlotProvider>
        <ConversationFooterShell>
          <Composer
            channel="general"
            context="channel"
            members={STREAM_MEMBERS}
            sendContract="accepted"
            autoFocus={false}
            onAcceptSend={() => true}
          />
        </ConversationFooterShell>
      </ConversationFooterSlotProvider>
    </div>
  ),
}
