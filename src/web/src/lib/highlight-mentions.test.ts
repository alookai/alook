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
  visibility: "public",
  owner_id: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
})

describe("highlightMentions", () => {
  it("wraps basic @AgentName", () => {
    const result = highlightMentions("Hey @TestBot do this", [agent("TestBot", "testbot")])
    expect(result).toBe("Hey @<mention>TestBot</mention> do this")
  })

  it("wraps only name portion of enriched form", () => {
    const result = highlightMentions("Hey @TestBot (testbot@alook.ai) do this", [agent("TestBot", "testbot")])
    expect(result).toBe("Hey @<mention>TestBot</mention> (testbot@alook.ai) do this")
  })

  it("leaves non-matching @ as plain text", () => {
    const result = highlightMentions("send to user@example.com", [agent("TestBot")])
    expect(result).toBe("send to user@example.com")
  })

  it("wraps multiple mentions", () => {
    const result = highlightMentions("@Alpha and @Beta", [agent("Alpha", "alpha"), agent("Beta", "beta")])
    expect(result).toBe("@<mention>Alpha</mention> and @<mention>Beta</mention>")
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
})
