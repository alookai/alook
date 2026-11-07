import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { Fixtures } from "../../../web/src/app/brand-visual/app-components"
import { Message } from "../../../web/src/components/community/messages/message"
import { CommunityPreviewNavigation } from "../../../web/src/components/community/shell/community-preview-navigation"
import { DEMO_MESSAGES } from "../../../web/src/components/home/landing-interactive-shell-data"

const first = DEMO_MESSAGES["demo-general"][0]
const meta = {
  title: "Web/Business/Message",
  component: Message,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "padded", docs: { description: { component: "Real message rows with the homepage's demo identities and existing Query/Community DB preview wrapper. Actions are local; this does not exercise server writes." } } },
  decorators: [(Story) => <Fixtures><CommunityPreviewNavigation value={true}><div className="mx-auto max-w-3xl"><Story /></div></CommunityPreviewNavigation></Fixtures>],
  args: { m: first, onOpenThread: fn(), onReply: fn(), onCopy: fn(), onReact: fn(), onToggleReaction: fn() },
  argTypes: { m: { control: "object" }, compact: { control: "boolean" } },
} satisfies Meta<typeof Message>

export default meta
type Story = StoryObj<typeof meta>

export const Text: Story = {}
export const Markdown: Story = { args: { m: { ...first, content: "## A shared plan\n\nA real **message renderer** with a [link](https://alook.ai), `inline code`, and a short list.\n\n- Read the current plan\n- Make the change\n- Share the result" } } }
export const Reply: Story = { args: { m: { ...first, replyTo: { id: "demo-previous", authorId: "demo-alli", authorName: "Alli", text: "Can we use the same components in the preview?" }, content: "Yes. The story imports the product Message component." } } }
export const LongContent: Story = { args: { m: { ...first, content: "A long message should wrap inside the available conversation width. ".repeat(18) } } }
