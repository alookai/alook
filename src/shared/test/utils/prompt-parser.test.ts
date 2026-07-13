import { describe, it, expect } from "vitest"
import { parsePromptMentions } from "../../src/utils/prompt-parser"

const bot = (name: string, emailHandle: string | null = null, description = "") => ({
  id: `ag_${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
  name,
  emailHandle,
  description,
})

describe("parsePromptMentions", () => {
  it("enriches a single mention with email", () => {
    const result = parsePromptMentions("Hey @TestBot do this", [bot("TestBot", "testbot")])
    expect(result.enrichedPrompt).toBe("Hey @TestBot (testbot@alook.ai) do this")
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0]).toEqual({ name: "TestBot", email: "testbot@alook.ai", description: "" })
  })

  it("enriches multiple mentions", () => {
    const result = parsePromptMentions("@Alpha and @Beta please coordinate", [
      bot("Alpha", "alpha"),
      bot("Beta", "beta"),
    ])
    expect(result.enrichedPrompt).toBe("@Alpha (alpha@alook.ai) and @Beta (beta@alook.ai) please coordinate")
    expect(result.mentions).toHaveLength(2)
  })

  it("leaves mention without email handle unchanged", () => {
    const result = parsePromptMentions("Ask @NoEmail about it", [bot("NoEmail")])
    expect(result.enrichedPrompt).toBe("Ask @NoEmail about it")
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].email).toBeNull()
  })

  it("does not match email addresses", () => {
    const result = parsePromptMentions("send to user@example.com", [bot("example", "ex")])
    expect(result.enrichedPrompt).toBe("send to user@example.com")
    expect(result.mentions).toHaveLength(0)
  })

  it("does not match mid-word @ with agent name", () => {
    const result = parsePromptMentions("email@TestBot", [bot("TestBot", "testbot")])
    expect(result.enrichedPrompt).toBe("email@TestBot")
    expect(result.mentions).toHaveLength(0)
  })

  it("does not match unknown agents", () => {
    const result = parsePromptMentions("@UnknownAgent hi", [bot("TestBot", "testbot")])
    expect(result.enrichedPrompt).toBe("@UnknownAgent hi")
    expect(result.mentions).toHaveLength(0)
  })

  it("matches case-insensitively and preserves canonical name", () => {
    const result = parsePromptMentions("hey @testbot", [bot("TestBot", "testbot")])
    expect(result.enrichedPrompt).toBe("hey @TestBot (testbot@alook.ai)")
    expect(result.mentions).toHaveLength(1)
  })

  it("prefers longest match (greedy)", () => {
    const result = parsePromptMentions("@SalesBot", [bot("Sales", "sales"), bot("SalesBot", "salesbot")])
    expect(result.enrichedPrompt).toBe("@SalesBot (salesbot@alook.ai)")
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].name).toBe("SalesBot")
  })

  it("matches mention at start of string", () => {
    const result = parsePromptMentions("@Bot do this", [bot("Bot", "bot")])
    expect(result.enrichedPrompt).toBe("@Bot (bot@alook.ai) do this")
    expect(result.mentions).toHaveLength(1)
  })

  it("matches mention after newline", () => {
    const result = parsePromptMentions("line one\n@Bot do this", [bot("Bot", "bot")])
    expect(result.enrichedPrompt).toBe("line one\n@Bot (bot@alook.ai) do this")
    expect(result.mentions).toHaveLength(1)
  })

  it("matches agent name with spaces", () => {
    const result = parsePromptMentions("Hey @Marketing Bot do this", [bot("Marketing Bot", "marketing-bot")])
    expect(result.enrichedPrompt).toBe("Hey @Marketing Bot (marketing-bot@alook.ai) do this")
    expect(result.mentions).toHaveLength(1)
  })

  it("does not match without @ prefix", () => {
    const result = parsePromptMentions("Hey Marketing Bot do this", [bot("Marketing Bot", "marketing-bot")])
    expect(result.enrichedPrompt).toBe("Hey Marketing Bot do this")
    expect(result.mentions).toHaveLength(0)
  })

  it("returns unchanged prompt with empty agent list", () => {
    const result = parsePromptMentions("Hey @Bot", [])
    expect(result.enrichedPrompt).toBe("Hey @Bot")
    expect(result.mentions).toHaveLength(0)
  })

  it("enriches duplicate mentions of same agent", () => {
    const result = parsePromptMentions("@Bot do this and @Bot do that", [bot("Bot", "bot")])
    expect(result.enrichedPrompt).toBe("@Bot (bot@alook.ai) do this and @Bot (bot@alook.ai) do that")
    expect(result.mentions).toHaveLength(2)
  })

  it("handles adjacent mentions: @Bot1@Bot2", () => {
    const result = parsePromptMentions("@Bot1@Bot2", [bot("Bot1", "bot1"), bot("Bot2", "bot2")])
    // @Bot1 matches (followed by @, a non-alphanumeric char)
    // @Bot2 does NOT match (@ preceded by '1', an alphanumeric)
    expect(result.enrichedPrompt).toBe("@Bot1 (bot1@alook.ai)@Bot2")
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0].name).toBe("Bot1")
  })

  it("matches agent name with special characters (parentheses)", () => {
    const result = parsePromptMentions("Hey @Bot (v2) do this", [bot("Bot (v2)", "bot-v2")])
    expect(result.enrichedPrompt).toBe("Hey @Bot (v2) (bot-v2@alook.ai) do this")
    expect(result.mentions).toHaveLength(1)
  })

  it("includes description in mention when present", () => {
    const result = parsePromptMentions("@Helper", [bot("Helper", "helper", "A helpful bot")])
    expect(result.mentions[0].description).toBe("A helpful bot")
  })

  it("handles @ after punctuation (parentheses, quotes)", () => {
    const result = parsePromptMentions('(@Bot) and "@Bot"', [bot("Bot", "bot")])
    expect(result.enrichedPrompt).toBe('(@Bot (bot@alook.ai)) and "@Bot (bot@alook.ai)"')
    expect(result.mentions).toHaveLength(2)
  })

  it("resolves a token by agent id and enriches", () => {
    const ada1 = { id: "ag_ada1", name: "Ada", emailHandle: "ada-one", description: "first" }
    const ada2 = { id: "ag_ada2", name: "Ada", emailHandle: "ada-two", description: "second" }
    const result = parsePromptMentions("The @[Ada](ag_ada2) will handle it", [ada1, ada2])
    expect(result.enrichedPrompt).toBe("The @Ada (ada-two@alook.ai) will handle it")
    expect(result.mentions).toHaveLength(1)
    expect(result.mentions[0]).toEqual({ name: "Ada", email: "ada-two@alook.ai", description: "second" })
  })

  it("picks the correct same-name agent by token id", () => {
    const ada1 = { id: "ag_ada1", name: "Ada", emailHandle: "ada-one", description: "" }
    const ada2 = { id: "ag_ada2", name: "Ada", emailHandle: "ada-two", description: "" }
    const result = parsePromptMentions("@[Ada](ag_ada1)", [ada1, ada2])
    expect(result.enrichedPrompt).toBe("@Ada (ada-one@alook.ai)")
    expect(result.mentions[0].email).toBe("ada-one@alook.ai")
  })

  it("strips an unmatched token (agent deleted) back to @Name", () => {
    const result = parsePromptMentions("Ask @[Ada](ag_gone) about it", [bot("Other", "other")])
    expect(result.enrichedPrompt).toBe("Ask @Ada about it")
    expect(result.mentions).toHaveLength(0)
  })

  it("strips tokens even when the agent list is empty (no leaked token)", () => {
    const result = parsePromptMentions("Hey @[Ada](ag_ada1) do this", [])
    expect(result.enrichedPrompt).toBe("Hey @Ada do this")
    expect(result.mentions).toHaveLength(0)
  })

  it("handles a token mixed with a bare-name mention", () => {
    const ada = { id: "ag_ada1", name: "Ada", emailHandle: "ada", description: "" }
    const bob = bot("Bob", "bob")
    const result = parsePromptMentions("@[Ada](ag_ada1) ping @Bob", [ada, bob])
    expect(result.enrichedPrompt).toBe("@Ada (ada@alook.ai) ping @Bob (bob@alook.ai)")
    expect(result.mentions).toHaveLength(2)
  })
})
