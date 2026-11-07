import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { BusinessFixtures } from "../../preview/business-fixtures"
import { MessageBody } from "@/components/community/messages/message-body"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"

const rich = '## Project notes\n\nA **real renderer** with [source code](https://github.com/alookai/alook), `inline code`, a table and local image.\n\n| Item | State |\n| --- | --- |\n| Brief | Ready |\n| Review | Open |\n\n$$E = mc^2$$\n\n```mermaid\nflowchart LR\n  Brief --> Review\n  Review --> Preview\n```\n\n![Local profile artwork](/landing/people/lin.webp)'
const meta = { title: "Web/Business/Full message markdown", component: MessageBody, tags: ["autodocs", "ai-generated"], args: { text: "A short message with **emphasis** and `code`.", perspective: "neutral" }, decorators: [(Story) => <BusinessFixtures><CommunityPreviewNavigation value={false}><div className="max-w-3xl"><Story /></div></CommunityPreviewNavigation></BusinessFixtures>], parameters: { docs: { description: { component: "Original full message renderer and its dynamically loaded math/Mermaid plugins. The homepage preview flag is disabled for this specific story so it uses the actual full renderer instead of the product's deliberately reduced demo plugin set." } } } } satisfies Meta<typeof MessageBody>
export default meta
type Story = StoryObj<typeof meta>
export const Plain: Story = {}
export const Rich: Story = { args: { text: rich } }
