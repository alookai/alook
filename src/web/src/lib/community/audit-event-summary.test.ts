import { describe, expect, it } from "vitest"
import { summarizeAuditEvent } from "./audit-event-summary"
import type { AuditKind } from "@/hooks/community/use-bot-audit-log"

describe("summarizeAuditEvent", () => {
  it("has bounded copy for every audit kind", () => {
    const kinds: AuditKind[] = [
      "cli_invocation",
      "tool_call",
      "thinking",
      "wake_trigger",
      "session_reset",
      "nap",
      "model_changed",
      "provider_changed",
      "error",
    ]
    const secret = "https://private.example/path?token=secret"

    for (const kind of kinds) {
      const summary = summarizeAuditEvent({ kind, payload: null })
      expect(summary.length).toBeGreaterThan(0)
      expect(summary).not.toContain(secret)
      expect(summary).not.toContain("private.example")
    }
  })

  it("shows the real short Alook command and tool name without arguments", () => {
    expect(summarizeAuditEvent({
      kind: "cli_invocation",
      payload: { subcommand: "inboxPull" },
    })).toBe("alook inbox pull")
    expect(summarizeAuditEvent({
      kind: "cli_invocation",
      payload: { subcommand: "attachmentUpload" },
    })).toBe("alook message attachment upload")
    expect(summarizeAuditEvent({
      kind: "cli_invocation",
      payload: { subcommand: "customCommand" },
    })).toBe("alook custom command")
    expect(summarizeAuditEvent({
      kind: "tool_call",
      payload: { name: "Exec_Command", target: "cat /Users/gus/private.txt" },
    })).toBe("exec_command")
  })

  it("never derives preview text from thinking, path, URL, or error payloads", () => {
    const event = {
      kind: "thinking" as const,
      payload: {
        thinking: "private chain of thought",
        path: "/Users/gus/secret.txt",
        url: "https://private.example",
        error: "credential failed",
      },
    }
    expect(summarizeAuditEvent(event)).toBe("Updated its reasoning")
    expect(summarizeAuditEvent(event)).not.toMatch(/secret|private|credential|Users/)
  })
})
