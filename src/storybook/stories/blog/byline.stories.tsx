import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { BlogPostByline } from "@blog/app/blog/[slug]/article-meta"

const meta = { title: "Blog/Article byline", component: BlogPostByline, tags: ["autodocs", "ai-generated"], args: { post: { author: "Alook Team", date: "2026-09-10", readingTime: "7 min read" } } } satisfies Meta<typeof BlogPostByline>
export default meta
type Story = StoryObj<typeof meta>
export const Published: Story = {}
export const Updated: Story = { args: { post: { author: "Alook Team", date: "2026-09-10", dateModified: "2026-11-05", readingTime: "7 min read" } } }
export const SameDate: Story = { args: { post: { author: "Alook Team", date: "2026-09-10", dateModified: "2026-09-10", readingTime: "7 min read" } } }
