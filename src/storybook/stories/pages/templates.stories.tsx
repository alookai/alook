import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { TemplatesClient } from "@/app/templates/client"
import TemplatesPage from "@/app/templates/page"
import TemplateDetailPage from "@/app/templates/[id]/page"
import { TemplateCard } from "@/app/templates/_components/template-card"
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/lib/templates"

const meta = { title: "Web/Pages/Templates", tags: ["ai-generated"], parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Directory: Story = { loaders: [async () => ({ page: await TemplatesPage() })], render: (_, context) => context.loaded.page }
export const Detail: Story = { loaders: [async () => ({ page: await TemplateDetailPage({ params: Promise.resolve({ id: TEMPLATES[0]!.id }) }) })], render: (_, context) => context.loaded.page }
export const Card: Story = { render: () => <div className="max-w-sm p-4"><TemplateCard template={TEMPLATES[0]!} /></div> }
export const EmptyDirectory: Story = { render: () => <TemplatesClient templates={[]} categories={TEMPLATE_CATEGORIES} /> }
