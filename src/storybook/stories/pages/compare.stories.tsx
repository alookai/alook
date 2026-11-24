import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import ComparePage from "@/app/compare/page"
import CompareDetailPage from "@/app/compare/[slug]/page"
import { COMPARE_PAGES } from "@/lib/compare"

const meta = {
  title: "Web/Pages/Compare",
  tags: ["ai-generated"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Real comparison hub and detail compositions built from COMPARE_PAGES.",
      },
    },
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Hub: Story = {
  render: () => <ComparePage />,
}

export const Detail: Story = {
  loaders: [async () => ({ page: await CompareDetailPage({ params: Promise.resolve({ slug: COMPARE_PAGES[0]!.slug }) }) })],
  render: (_, context) => context.loaded.page,
}
