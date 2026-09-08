import { describe, expect, it } from "vitest"
import { resolveConversationSubtype } from "./conversation-subtype"

describe("resolveConversationSubtype", () => {
  it.each([
    ["pending", true],
    ["terminal-error", true],
    ["ready", false],
  ] as const)("keeps stale or unproved metadata neutral: %s / access=%s", (routeLifecycle, accessAllowed) => {
    expect(resolveConversationSubtype({
      routeLifecycle,
      accessAllowed,
      isChild: false,
      isForum: true,
    })).toBe("unknown")
  })

  it.each([
    [{ isChild: false, isForum: false }, "text"],
    [{ isChild: false, isForum: true }, "forum"],
    [{ isChild: true, isForum: false }, "thread"],
    [{ isChild: true, isForum: true }, "thread"],
  ] as const)("selects $1 only after canonical readiness", (metadata, expected) => {
    expect(resolveConversationSubtype({
      routeLifecycle: "ready",
      accessAllowed: true,
      ...metadata,
    })).toBe(expected)
  })

  it.each(["text", "forum", "thread"] as const)(
    "uses the persisted %s subtype only for a pending skeleton",
    (structuralHint) => {
      expect(resolveConversationSubtype({
        routeLifecycle: "pending",
        accessAllowed: false,
        isChild: false,
        isForum: false,
        structuralHint,
      })).toBe(structuralHint)

      expect(resolveConversationSubtype({
        routeLifecycle: "terminal-error",
        accessAllowed: true,
        isChild: false,
        isForum: false,
        structuralHint,
      })).toBe("unknown")
    },
  )
})
