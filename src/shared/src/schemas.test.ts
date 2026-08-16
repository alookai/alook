import { describe, it, expect } from "vitest"
import {
  CommunityBotCreateRequestSchema,
  CommunityBotPatchRequestSchema,
  AgentTypingMessageSchema,
  AgentTypingStopMessageSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  BotAuditEventSchema,
  BotAuditEventKindSchema,
  CommunityAgentNapRequestSchema,
} from "./schemas"

function validCreatePayload(image?: string) {
  return {
    name: "MyBot",
    machineId: "m1",
    runtime: "node",
    ...(image !== undefined ? { image } : {}),
  }
}

describe("CommunityAgentNapRequestSchema", () => {
  it("rejects whitespace-only handoffs without trimming valid literal content", () => {
    expect(CommunityAgentNapRequestSchema.safeParse({ handoff: "  \n\t" }).success).toBe(false)
    const handoff = "  literal \\\\n text\n中文 🎉  \n"
    expect(CommunityAgentNapRequestSchema.parse({ handoff }).handoff).toBe(handoff)
  })
})

describe("BotImageUrlSchema (via CommunityBotCreateRequestSchema)", () => {
  it("accepts an https URL", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("https://cdn.example.com/a.png"))
    expect(res.success).toBe(true)
  })

  it("accepts an avatar: procedural config", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("avatar:shape=star"))
    expect(res.success).toBe(true)
  })

  it("accepts a leading-/ routable path (bot-avatar upload route shape)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("/api/community/bots/b1/avatar"))
    expect(res.success).toBe(true)
  })

  it("rejects a bare (non-routable, non-https, non-avatar:) string", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("not-a-url"))
    expect(res.success).toBe(false)
  })

  it("rejects http:// (only https:// is allowed)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("http://cdn.example.com/a.png"))
    expect(res.success).toBe(false)
  })

  it("rejects a protocol-relative URL (starts with `/` but resolves off-origin)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("//evil.com/pixel.gif"))
    expect(res.success).toBe(false)
  })

  it("rejects an arbitrary same-origin path that isn't the bot avatar route", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload("/some/internal/route"))
    expect(res.success).toBe(false)
  })

  it("rejects a bot avatar route for a different bot id shape (path traversal attempt)", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(
      validCreatePayload("/api/community/bots/../../etc/passwd/avatar"),
    )
    expect(res.success).toBe(false)
  })

  it("image field remains optional", () => {
    const res = CommunityBotCreateRequestSchema.safeParse(validCreatePayload())
    expect(res.success).toBe(true)
  })
})

describe("BotImageUrlSchema (via CommunityBotPatchRequestSchema)", () => {
  it("accepts a leading-/ routable path", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: "/api/community/bots/b1/avatar" })
    expect(res.success).toBe(true)
  })

  it("still accepts null to clear the image", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: null })
    expect(res.success).toBe(true)
  })

  it("rejects an invalid image string", () => {
    const res = CommunityBotPatchRequestSchema.safeParse({ image: "ftp://nope" })
    expect(res.success).toBe(false)
  })
})

describe("AgentTypingMessageSchema", () => {
  it("parses a well-formed frame", () => {
    const res = AgentTypingMessageSchema.safeParse({
      type: "agent_typing",
      agentId: "bot_1",
      channelId: "c_1",
    })
    expect(res.success).toBe(true)
  })

  it("rejects missing channelId", () => {
    const res = AgentTypingMessageSchema.safeParse({ type: "agent_typing", agentId: "bot_1" })
    expect(res.success).toBe(false)
  })

  it("rejects empty channelId (min length 1)", () => {
    const res = AgentTypingMessageSchema.safeParse({
      type: "agent_typing",
      agentId: "bot_1",
      channelId: "",
    })
    expect(res.success).toBe(false)
  })

  it("rejects missing agentId", () => {
    const res = AgentTypingMessageSchema.safeParse({
      type: "agent_typing",
      channelId: "c_1",
    })
    expect(res.success).toBe(false)
  })

  it("rejects the wrong discriminant", () => {
    const res = AgentTypingMessageSchema.safeParse({
      type: "agent_activity",
      agentId: "bot_1",
      channelId: "c_1",
    })
    expect(res.success).toBe(false)
  })
})

describe("AgentTypingStopMessageSchema", () => {
  it("parses a well-formed frame", () => {
    const res = AgentTypingStopMessageSchema.safeParse({
      type: "agent_typing_stop",
      agentId: "bot_1",
      channelId: "c_1",
    })
    expect(res.success).toBe(true)
  })

  it("rejects missing channelId", () => {
    const res = AgentTypingStopMessageSchema.safeParse({
      type: "agent_typing_stop",
      agentId: "bot_1",
    })
    expect(res.success).toBe(false)
  })

  it("rejects missing agentId", () => {
    const res = AgentTypingStopMessageSchema.safeParse({
      type: "agent_typing_stop",
      channelId: "c_1",
    })
    expect(res.success).toBe(false)
  })
})

describe("CreateWorkspaceRequestSchema slug sanitization", () => {
  it("sanitizes a dirty slug to ASCII kebab-case", () => {
    const res = CreateWorkspaceRequestSchema.parse({ name: "Acme", slug: "My Company" })
    expect(res.slug).toBe("my-company")
  })

  it("defaults an omitted slug to empty (route generates)", () => {
    const res = CreateWorkspaceRequestSchema.parse({ name: "Acme" })
    expect(res.slug).toBe("")
  })

  it("yields empty for an unsanitizable slug (route falls back)", () => {
    const res = CreateWorkspaceRequestSchema.parse({ name: "Acme", slug: "🎉" })
    expect(res.slug).toBe("")
  })
})

describe("UpdateWorkspaceRequestSchema slug sanitization", () => {
  it("sanitizes a provided slug", () => {
    const res = UpdateWorkspaceRequestSchema.parse({ slug: "New Slug" })
    expect(res.slug).toBe("new-slug")
  })

  it("transforms an unsanitizable slug to empty (route rejects)", () => {
    const res = UpdateWorkspaceRequestSchema.parse({ slug: "🎉" })
    expect(res.slug).toBe("")
  })

  it("leaves slug undefined and does not throw when omitted", () => {
    const res = UpdateWorkspaceRequestSchema.parse({ name: "x" })
    expect(res.slug).toBeUndefined()
    expect(res.name).toBe("x")
  })

  it("accepts and truncates a very long messy slug (no max rejection)", () => {
    const res = UpdateWorkspaceRequestSchema.parse({ slug: "A very long name ".repeat(20) })
    expect(res.slug!.length).toBeLessThanOrEqual(60)
  })
})

describe("CommunityBotCreateRequestSchema — model", () => {
  it("accepts a model string, accepts null, rejects empty and >100 chars", () => {
    expect(CommunityBotCreateRequestSchema.safeParse({ ...validCreatePayload(), model: "claude-opus-4-6" }).success).toBe(true)
    expect(CommunityBotCreateRequestSchema.safeParse({ ...validCreatePayload(), model: null }).success).toBe(true)
    // omitted is fine (untouched)
    expect(CommunityBotCreateRequestSchema.safeParse(validCreatePayload()).success).toBe(true)
    expect(CommunityBotCreateRequestSchema.safeParse({ ...validCreatePayload(), model: "" }).success).toBe(false)
    expect(CommunityBotCreateRequestSchema.safeParse({ ...validCreatePayload(), model: "x".repeat(101) }).success).toBe(false)
  })
})

describe("CommunityBotPatchRequestSchema — model", () => {
  it("accepts {model: 'x'} and {model: null} as the sole field", () => {
    expect(CommunityBotPatchRequestSchema.safeParse({ model: "claude-opus-4-6" }).success).toBe(true)
    // explicit null must count as present for the at-least-one refine
    expect(CommunityBotPatchRequestSchema.safeParse({ model: null }).success).toBe(true)
  })
  it("rejects an empty object (no fields)", () => {
    expect(CommunityBotPatchRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe("BotAuditEventSchema — model_changed", () => {
  it("parses a model_changed event with null-able from/to", () => {
    expect(
      BotAuditEventSchema.safeParse({ kind: "model_changed", payload: { from: "a", to: "b" } }).success,
    ).toBe(true)
    expect(
      BotAuditEventSchema.safeParse({ kind: "model_changed", payload: { from: null, to: "b" } }).success,
    ).toBe(true)
    expect(
      BotAuditEventSchema.safeParse({ kind: "model_changed", payload: { from: "a", to: null } }).success,
    ).toBe(true)
  })
  it("rejects a payload missing `to`", () => {
    expect(
      BotAuditEventSchema.safeParse({ kind: "model_changed", payload: { from: "a" } }).success,
    ).toBe(false)
  })
  it("BotAuditEventKindSchema includes model_changed", () => {
    expect(BotAuditEventKindSchema.safeParse("model_changed").success).toBe(true)
  })
})

describe("BotAuditEventSchema — error", () => {
  it("parses an error event across all scopes with a null-able model", () => {
    for (const scope of ["spawn", "runtime", "exit", "handshake_timeout", "model_switch", "reset"]) {
      expect(
        BotAuditEventSchema.safeParse({
          kind: "error",
          payload: { scope, code: "handshake_timeout", message: "no response", model: "claude-bogus" },
        }).success,
      ).toBe(true)
    }
    expect(
      BotAuditEventSchema.safeParse({
        kind: "error",
        payload: { scope: "spawn", code: "ENOENT", message: "not found", model: null },
      }).success,
    ).toBe(true)
  })
  it("rejects an unknown scope and an empty code", () => {
    expect(
      BotAuditEventSchema.safeParse({
        kind: "error",
        payload: { scope: "nope", code: "x", message: "m", model: null },
      }).success,
    ).toBe(false)
    expect(
      BotAuditEventSchema.safeParse({
        kind: "error",
        payload: { scope: "spawn", code: "", message: "m", model: null },
      }).success,
    ).toBe(false)
  })
  it("BotAuditEventKindSchema includes error", () => {
    expect(BotAuditEventKindSchema.safeParse("error").success).toBe(true)
  })
})
