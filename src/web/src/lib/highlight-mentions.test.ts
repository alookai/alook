import { describe, it, expect } from "vitest"
import { highlightMentions } from "./highlight-mentions"
import type { Agent } from "@alook/shared"

const agent = (name: string, email_handle: string | null = null): Agent => ({
  id: `ag_${name.toLowerCase()}`,
  workspace_id: "ws_1",
  runtime_id: "rt_1",
  name,
  description: "",
  instructions: "",
  runtime_mode: "daemon",
  runtime_config: {},
  status: "active",
  max_concurrent_tasks: 1,
  email_handle,
  avatar_url: null,
  visibility: "public",
  owner_id: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
})

describe("highlightMentions", () => {
  it("wraps basic @AgentName with data-agent-id", () => {
    const result = highlightMentions("Hey @TestBot do this", [agent("TestBot", "testbot")])
    expect(result).toBe('Hey <mention data-agent-id="ag_testbot">@TestBot</mention> do this')
  })

  it("wraps only name portion of enriched form", () => {
    const result = highlightMentions("Hey @TestBot (testbot@alook.ai) do this", [agent("TestBot", "testbot")])
    expect(result).toBe('Hey <mention data-agent-id="ag_testbot">@TestBot</mention> (testbot@alook.ai) do this')
  })

  it("leaves non-matching @ as plain text", () => {
    const result = highlightMentions("send to user@example.com", [agent("TestBot")])
    expect(result).toBe("send to user@example.com")
  })

  it("wraps multiple mentions with correct agent ids", () => {
    const result = highlightMentions("@Alpha and @Beta", [agent("Alpha", "alpha"), agent("Beta", "beta")])
    expect(result).toBe('<mention data-agent-id="ag_alpha">@Alpha</mention> and <mention data-agent-id="ag_beta">@Beta</mention>')
  })

  it("does not wrap unknown agent names", () => {
    const result = highlightMentions("Hey @Unknown", [agent("TestBot")])
    expect(result).toBe("Hey @Unknown")
  })

  it("returns unchanged with no @ symbols", () => {
    const result = highlightMentions("Hello world", [agent("TestBot")])
    expect(result).toBe("Hello world")
  })

  it("returns unchanged with empty agents", () => {
    const result = highlightMentions("Hey @TestBot", [])
    expect(result).toBe("Hey @TestBot")
  })

  it("includes data-agent-id attribute on mention tags", () => {
    const result = highlightMentions("Hello @TestBot", [agent("TestBot")])
    expect(result).toContain('data-agent-id="ag_testbot"')
  })

  it("includes correct agent id for each mention when multiple agents are mentioned", () => {
    const agents = [agent("Alice", "alice"), agent("Bob", "bob")]
    const result = highlightMentions("@Alice talk to @Bob", agents)
    expect(result).toContain('data-agent-id="ag_alice"')
    expect(result).toContain('data-agent-id="ag_bob"')
    expect(result).toBe('<mention data-agent-id="ag_alice">@Alice</mention> talk to <mention data-agent-id="ag_bob">@Bob</mention>')
  })

  it("wraps a token by its agent id", () => {
    const result = highlightMentions("Hey @[Ada](ag_ada1) do this", [agent("Ada")])
    expect(result).toBe('Hey <mention data-agent-id="ag_ada1">@Ada</mention> do this')
  })

  it("locks a token to its id even with two same-name agents", () => {
    const agents = [
      { ...agent("Ada"), id: "ag_ada1" },
      { ...agent("Ada"), id: "ag_ada2" },
    ]
    const result = highlightMentions("@[Ada](ag_ada2)", agents)
    expect(result).toBe('<mention data-agent-id="ag_ada2">@Ada</mention>')
  })

  it("wraps a token even when agents is empty (no markdown link leak)", () => {
    const result = highlightMentions("Hey @[Ada](ag_ada1) do this", [])
    expect(result).toBe('Hey <mention data-agent-id="ag_ada1">@Ada</mention> do this')
    expect(result).not.toContain("](ag_ada1)")
  })

  it("wraps a token whose agent is unknown (deleted) — still not a markdown link", () => {
    const result = highlightMentions("Hey @[Ada](ag_gone) do this", [agent("TestBot")])
    expect(result).toBe('Hey <mention data-agent-id="ag_gone">@Ada</mention> do this')
  })

  it("handles a token mixed with a bare-name mention", () => {
    const result = highlightMentions("@[Ada](ag_ada1) and @Bob", [agent("Bob", "bob")])
    expect(result).toBe('<mention data-agent-id="ag_ada1">@Ada</mention> and <mention data-agent-id="ag_bob">@Bob</mention>')
  })

  it("does not treat a normal markdown link as a mention token", () => {
    const link = "see [docs](https://example.com/a.b:c) now"
    expect(highlightMentions(link, [agent("docs")])).toBe(link)
  })
})
