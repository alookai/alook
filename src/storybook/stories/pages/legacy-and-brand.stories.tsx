import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { HomePage } from "@/components/home/home-page"
import BrandVisualPage from "@/app/brand-visual/page"

const meta = { title: "Web/Pages/Design references", tags: ["ai-generated"], parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const LegacyLanding: Story = { render: () => <HomePage isLoggedIn={false} /> }
export const BrandBoard: Story = { render: () => <BrandVisualPage /> }
