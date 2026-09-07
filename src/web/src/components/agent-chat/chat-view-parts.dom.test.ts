import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render as renderDom, screen } from "@/test/react-dom-harness"
import type { Agent, Artifact } from "@alook/shared"
import { RemoteMarkdownImage } from "@/components/remote-image/remote-markdown-image"
import { ArtifactCard, MENTION_COMPONENTS } from "./chat-view-parts"

const agents: Agent[] = []

vi.mock("@/contexts/agent-context", () => ({
  useAgentContext: () => ({ agents }),
}))

vi.mock("@/components/agent-preview-card", () => ({
  AgentPreviewCard: ({ agent }: { agent: { id: string } }) =>
    createElement("div", { "data-preview-agent-id": agent.id }),
}))

const agent = (id: string, name: string): Agent => ({
  id,
  workspace_id: "ws_1",
  runtime_id: "rt_1",
  name,
  description: "",
  instructions: "",
  runtime_mode: "daemon",
  runtime_config: {},
  status: "active",
  max_concurrent_tasks: 1,
  email_handle: null,
  avatar_url: null,
  visibility: "public",
  owner_id: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
})

function renderMention(props: Record<string, unknown>): string {
  const Mention = MENTION_COMPONENTS.mention
  return renderToStaticMarkup(createElement(Mention, props))
}

// The popover content (with the preview card carrying the resolved id) is lazy
// under SSR, so the load-bearing signal is the trigger: a resolved agent renders
// a clickable popover trigger, an unresolved one a plain text span.
const isClickable = (html: string) =>
  html.includes("cursor-pointer") && html.includes('data-slot="popover-trigger"')

describe("MentionHighlight", () => {
  it("resolves a same-name agent by data-agent-id (clickable), unaffected by a duplicate name", () => {
    agents.length = 0
    agents.push(agent("ag_ada1", "Ada"), agent("ag_ada2", "Ada"))
    expect(isClickable(renderMention({ "data-agent-id": "ag_ada2", children: "@Ada" }))).toBe(true)
  })

  it("falls back to name only when there is no agent id (historic bare mention)", () => {
    agents.length = 0
    agents.push(agent("ag_bob", "Bob"))
    expect(isClickable(renderMention({ children: "@Bob" }))).toBe(true)
  })

  it("does not name-fallback when an id is present — a gone agent renders non-clickable text", () => {
    agents.length = 0
    // A same-name agent exists under a different id; it must NOT be matched,
    // proving resolution is strictly by id, never by name, when an id is present.
    agents.push(agent("ag_other", "Ada"))
    const html = renderMention({ "data-agent-id": "ag_gone", children: "@Ada" })
    expect(isClickable(html)).toBe(false)
    expect(html).toContain("@Ada")
  })
})

const IMAGE_ARTIFACT: Artifact = {
  id: "artifact-1",
  conversation_id: "conversation-1",
  agent_id: "agent-1",
  filename: "diagram.png",
  content_type: "image/png",
  size: 128,
  source: "agent",
  has_thumbnail: true,
  created_at: "2026-01-01T00:00:00Z",
}

describe("Agent Chat remote images", () => {
  it("uses the shared Markdown image adapter", () => {
    expect(MENTION_COMPONENTS.img).toBe(RemoteMarkdownImage)
  })

  it("keeps a failed artifact thumbnail as an explicit retryable image card", async () => {
    const onClick = vi.fn()
    const rendered = renderDom(React.createElement(ArtifactCard, {
      artifact: IMAGE_ARTIFACT,
      version: 1,
      hasDuplicates: false,
      onClick,
      workspaceId: "workspace-1",
    }))

    const image = rendered.container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')!
    const originalSrc = image.src
    fireEvent.error(image)

    const retry = screen.getByRole("button", { name: "Retry" })
    fireEvent.click(retry)
    expect(rendered.container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')?.src)
      .toBe(originalSrc)
    expect(onClick).not.toHaveBeenCalled()
  })
})
