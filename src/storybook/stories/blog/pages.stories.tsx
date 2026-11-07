import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import type { ReactNode } from "react"
import BlogIndexPage from "@blog/app/blog/(index)/page"
import BlogPostPage from "@blog/app/blog/[slug]/page"
import BlogLayout from "@blog/app/blog/layout"
import GuidesPage from "@blog/app/guides/page"
import GuidesLayout from "@blog/app/guides/layout"
import TutorialsPage from "@blog/app/tutorials/page"
import TutorialsLayout from "@blog/app/tutorials/layout"
import TutorialPage from "@blog/app/tutorials/[slug]/page"
import { stepGuides } from "@/lib/step-guides"

const pageLoader = (factory: () => Promise<ReactNode>) => async () => ({ page: await factory() })
const meta = { title: "Blog/Pages", tags: ["ai-generated"], parameters: { layout: "fullscreen", docs: { description: { component: "Actual Blog page functions, awaited by Storybook loaders, with original MDX options, components and page layouts. This previews their React output; it does not run the Blog Worker or validate server routing/SEO responses." } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Index: Story = { loaders: [pageLoader(() => BlogIndexPage())], render: (_, context) => <BlogLayout>{context.loaded.page}</BlogLayout> }
export const Article: Story = { loaders: [pageLoader(() => BlogPostPage({ params: Promise.resolve({ slug: "introducing-alook" }) }))], render: (_, context) => <BlogLayout>{context.loaded.page}</BlogLayout> }
export const Guides: Story = { loaders: [pageLoader(() => GuidesPage())], render: (_, context) => <GuidesLayout>{context.loaded.page}</GuidesLayout> }
export const Tutorials: Story = { render: () => <TutorialsLayout><TutorialsPage /></TutorialsLayout> }
export const Tutorial: Story = { loaders: [pageLoader(() => TutorialPage({ params: Promise.resolve({ slug: stepGuides[0]!.slug }) }))], render: (_, context) => <TutorialsLayout>{context.loaded.page}</TutorialsLayout> }
