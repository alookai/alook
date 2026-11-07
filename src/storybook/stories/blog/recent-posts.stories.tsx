import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { RecentPosts } from "@blog/app/blog/(index)/recent-posts"
import { buildBlogIndexModel } from "@blog/app/blog/(index)/model"
import { blogTopics } from "@blog/lib/blog/topics"
import { metadata as introduction } from "@blog/content/introducing-alook.mdx"
import { metadata as collaboration } from "@blog/content/claude-code-and-codex-same-team.mdx"

const posts = buildBlogIndexModel([introduction, collaboration]).recent
const meta = { title: "Blog/Recent posts", component: RecentPosts, tags: ["autodocs", "ai-generated"], args: { posts, topics: blogTopics.map(({ id, label }) => ({ id, label })) }, parameters: { docs: { description: { component: "Original post cards and topic filtering, using metadata imported from actual published MDX files." } } } } satisfies Meta<typeof RecentPosts>
export default meta
type Story = StoryObj<typeof meta>
export const PublishedPosts: Story = {}
export const Empty: Story = { args: { posts: [] } }
export const LongTitle: Story = { args: { posts: posts.map((post) => ({ ...post, title: `${post.title}: an extended heading to inspect narrow card wrapping` })) } }
