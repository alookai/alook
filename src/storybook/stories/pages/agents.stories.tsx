import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import AgentsPage from "@/app/agents/page"
import AgentDetailPage from "@/app/agents/[slug]/page"
import { AGENT_RUNTIME_PAGES } from "@/lib/agents"

const meta = {
  title: "Web/Pages/Agents",
  tags: ["ai-generated"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Real supported local-agent hub and runtime detail compositions with live community shell previews.",
      },
    },
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Hub: Story = {
  render: () => <AgentsPage />,
}

export const Detail: Story = {
  loaders: [async () => ({ page: await AgentDetailPage({ params: Promise.resolve({ slug: AGENT_RUNTIME_PAGES[0]!.slug }) }) })],
  render: (_, context) => context.loaded.page,
}
