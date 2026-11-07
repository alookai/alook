import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { CompanyIntroductions } from "@blog/components/company-introductions"
import { CompanyJobBrief } from "@blog/components/company-job-brief"
import { CompanyRoles } from "@blog/components/company-roles"
import { ConnectDemo, BotsDemo } from "@blog/components/guides/mock-scenes"
import { ServerDemo } from "@blog/components/guides/server-demo"
import { MessageDemo } from "@blog/components/guides/message-demo"
import { Prerequisites } from "@blog/components/guides/prerequisites"
import BlogError from "@blog/app/error"
import BlogNotFound from "@blog/app/not-found"
import { BlogPostByline } from "@blog/app/blog/[slug]/article-meta"
import { AgentAvatar } from "@/components/avatar/agent-avatar"

const meta = { title: "Blog/Components", tags: ["ai-generated"], parameters: { layout: "padded" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Introductions: Story = { render: () => <CompanyIntroductions /> }
export const JobBrief: Story = { render: () => <div className="blog-prose"><CompanyJobBrief><h2>Website changes</h2><p>Review the preview before publication.</p><ul><li>Requested changes</li><li>Review evidence</li></ul></CompanyJobBrief></div> }
export const Roles: Story = { render: () => <CompanyRoles avatars={["sales", "delivery", "review", "customer-ops"].map((seed) => <AgentAvatar key={seed} seed={seed} size={48} />)} /> }
export const Connect: Story = { render: () => <ConnectDemo /> }
export const Bots: Story = { render: () => <BotsDemo runtime="codex" /> }
export const Server: Story = { render: () => <ServerDemo /> }
export const Message: Story = { render: () => <MessageDemo /> }
export const Requirements: Story = { render: () => <Prerequisites><p>A local machine and an available coding agent.</p></Prerequisites> }
export const Byline: Story = { render: () => <BlogPostByline post={{ author: "Alook Team", date: "2026-09-10", dateModified: "2026-11-05", readingTime: "7 min read" }} /> }
export const NotFound: Story = { render: () => <BlogNotFound /> }
export const Error: Story = { render: () => <BlogError error={new globalThis.Error("Local preview")} reset={fn()} /> }
