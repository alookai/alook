import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { CompanyIntroductions } from "@blog/components/company-introductions"
import { CompanyJobBrief } from "@blog/components/company-job-brief"
import { CompanyRoles } from "@blog/components/company-roles"
import { ConnectDemo, BotsDemo } from "@blog/components/guides/mock-scenes"
import { ServerDemo } from "@blog/components/guides/server-demo"
import { MessageDemo } from "@blog/components/guides/message-demo"
import { StoryDemo } from "@blog/components/guides/story-demo"
import { TriggerFlowDemo } from "@blog/components/guides/trigger-flow-demo"
import { TriggerSetupDemo } from "@blog/components/guides/trigger-setup-demo"
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
export const UseCaseStory: Story = { render: () => <StoryDemo label="Use case story" channel="seo" channels={["general", "seo"]} steps={[{ send: "Nina", mentions: ["Scout"], text: "Which pages get the most search traffic?" }, { post: "Scout", text: "/compress-pdf leads with 18.2k monthly visits." }]} /> }
export const TriggerFlow: Story = {
  render: () => (
    <TriggerFlowDemo
      label="GitHub trigger closed-loop preview"
      provider="github"
      channel="fixes"
      threadTitle="Issue #214: Image export fails"
      botName="Atlas"
      stages={[
        {
          id: "issue-opened",
          tabLabel: "1. Issue opens",
          direction: "to-alook",
          signalLabel: "issues.opened wakes Atlas",
          signalTag: "issues.opened",
          external: {
            header: "Issue #214",
            workspace: "mossnote / mossnote",
            tab: "issues",
            number: "#214",
            labelTag: "ready-for-agent",
            status: "open",
            statusLabel: "Open",
            title: "Exporting a note with an image fails in nested folders",
            detail: "Reporter attached repro steps.",
          },
          messages: [{ author: "Atlas", meta: "Claude Code", time: "10:02", text: "Reproduced locally and opened PR #215." }],
        },
      ]}
    />
  ),
}
export const TriggerSetup: Story = {
  render: () => (
    <TriggerSetupDemo
      provider="github"
      botName="Atlas"
      triggerName="mossnote-ci"
      externalMenuPath="GitHub · Settings → Webhooks → Add webhook"
      externalFields={[{ label: "Payload URL", value: "https://alook.ai/api/webhooks/bot/trk_demo", mono: true }]}
      externalEvents={["Issues", "Workflow runs"]}
      connectedSummary="GitHub ping verified."
    />
  ),
}
export const Requirements: Story = { render: () => <Prerequisites><p>A local machine and an available coding agent.</p></Prerequisites> }
export const Byline: Story = { render: () => <BlogPostByline post={{ author: "Alook Team", date: "2026-09-10", dateModified: "2026-11-05", readingTime: "7 min read" }} /> }
export const NotFound: Story = { render: () => <BlogNotFound /> }
export const Error: Story = { render: () => <BlogError error={new globalThis.Error("Local preview")} reset={fn()} /> }
