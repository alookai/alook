import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Agent } from "@alook/shared"

const agents: Agent[] = []

vi.mock("@/contexts/agent-context", () => ({
  useAgentContext: () => ({ agents }),
}))

vi.mock("@/components/agent-preview-card", () => ({
  AgentPreviewCard: ({ agent }: { agent: { id: string } }) =>
    createElement("div", { "data-preview-agent-id": agent.id }),
}))

import { MENTION_COMPONENTS } from "./chat-view-parts"

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
