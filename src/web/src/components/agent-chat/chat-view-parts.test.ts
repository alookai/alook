import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Agent, Artifact } from "@alook/shared"
import { FileCard } from "@/components/agent-chat/event-cards/file-card"
import { RemoteMarkdownImage } from "@/components/remote-image"
import { ArtifactCard, MENTION_COMPONENTS } from "./chat-view-parts"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

function render(props: Record<string, unknown>): string {
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
    expect(isClickable(render({ "data-agent-id": "ag_ada2", children: "@Ada" }))).toBe(true)
  })

  it("falls back to name only when there is no agent id (historic bare mention)", () => {
    agents.length = 0
    agents.push(agent("ag_bob", "Bob"))
    expect(isClickable(render({ children: "@Bob" }))).toBe(true)
  })

  it("does not name-fallback when an id is present — a gone agent renders non-clickable text", () => {
    agents.length = 0
    // A same-name agent exists under a different id; it must NOT be matched,
    // proving resolution is strictly by id, never by name, when an id is present.
    agents.push(agent("ag_other", "Ada"))
    const html = render({ "data-agent-id": "ag_gone", children: "@Ada" })
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
  let renderer: TestRenderer.ReactTestRenderer | undefined

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
  })

  it("uses the shared Markdown image adapter", () => {
    expect(MENTION_COMPONENTS.img).toBe(RemoteMarkdownImage)
  })

  it("keeps a failed artifact thumbnail as an explicit retryable image card", async () => {
    const onClick = vi.fn()
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ArtifactCard, {
        artifact: IMAGE_ARTIFACT,
        version: 1,
        hasDuplicates: false,
        onClick,
        workspaceId: "workspace-1",
      }), {
        createNodeMock: (element) => {
          if (element.type === "img") return { complete: false, naturalWidth: 0, naturalHeight: 0 }
          if (element.props["data-remote-image-frame"] !== undefined) return {}
          return null
        },
      })
    })

    const image = renderer!.root.findByProps({ "data-remote-image-kind": "content" })
    const originalSrc = image.props.src
    await act(async () => image.props.onError())

    expect(renderer!.root.findAllByType(FileCard)).toHaveLength(0)
    const retry = renderer!.root.findByType("button")
    expect(retry.children).toEqual(["Retry"])
    await act(async () => retry.props.onClick())
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props.src).toBe(originalSrc)
    expect(onClick).not.toHaveBeenCalled()
  })
})
