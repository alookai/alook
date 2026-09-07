import { describe, it, expect } from "vitest"
import React from "react"
import { render as renderDom } from "@/test/react-dom-harness"

import { BotActivityRow } from "./bot-activity-row"
import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"

function render(event: AuditEvent) {
  return renderDom(React.createElement(BotActivityRow, { event }))
}

function rowText(renderer: ReturnType<typeof renderDom>, testid: string): string {
  return renderer.getByTestId(testid).textContent!.replace(/\s+/g, " ").trim()
}

function modelRowText(renderer: ReturnType<typeof renderDom>): string {
  return rowText(renderer, "bot-activity-event-model_changed")
}

describe("BotActivityRow — model_changed", () => {
  it("renders the raw stored ids from → to", () => {
    const renderer = render({
      id: "e1",
      kind: "model_changed",
      payload: { from: "claude-opus-4-6", to: "claude-sonnet-4-6" },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    expect(modelRowText(renderer)).toContain("claude-opus-4-6")
    expect(modelRowText(renderer)).toContain("→")
    expect(modelRowText(renderer)).toContain("claude-sonnet-4-6")
  })

  it("substitutes the literal `default` for a null `from`", () => {
    const renderer = render({
      id: "e2",
      kind: "model_changed",
      payload: { from: null, to: "claude-sonnet-4-6" },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    expect(modelRowText(renderer)).toContain("default")
    expect(modelRowText(renderer)).toContain("claude-sonnet-4-6")
  })
})

describe("BotActivityRow — concrete command copy", () => {
  it("renders the actual short CLI command", () => {
    const renderer = render({
      id: "e-cli",
      kind: "cli_invocation",
      payload: { subcommand: "inboxPull" },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    expect(renderer.container).toHaveTextContent("alook inbox pull")
  })

  it("renders the normalized tool name", () => {
    const renderer = render({
      id: "e-tool",
      kind: "tool_call",
      payload: { name: "Read", target: "/tmp/notes.md" },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    expect(renderer.container).toHaveTextContent("read")
  })
})

describe("BotActivityRow — turn_interrupt", () => {
  it("states daemon acceptance without claiming the turn is already idle", () => {
    const renderer = render({
      id: "e-stop",
      kind: "turn_interrupt",
      payload: { status: "accepted" },
      sessionId: "session-1",
      launchId: "launch-1",
      createdAt: "2026-09-01T14:00:00.000Z",
    })
    const text = rowText(renderer, "bot-activity-event-turn_interrupt")
    expect(text).toContain("Stop accepted by daemon")
    expect(text).toContain("waiting for the active turn to become idle")
  })
})

describe("BotActivityRow — provider_changed", () => {
  function providerRowText(renderer: ReturnType<typeof renderDom>): string {
    return rowText(renderer, "bot-activity-event-provider_changed")
  }

  it("renders runtime ids from → to", () => {
    const renderer = render({
      id: "e5",
      kind: "provider_changed",
      payload: { from: "claude", to: "codex" },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    expect(providerRowText(renderer)).toContain("claude")
    expect(providerRowText(renderer)).toContain("→")
    expect(providerRowText(renderer)).toContain("codex")
  })
})

describe("BotActivityRow — error", () => {
  it("renders the failure message plus the code · model detail", () => {
    const renderer = render({
      id: "e3",
      kind: "error",
      payload: {
        scope: "handshake_timeout",
        code: "handshake_timeout",
        message: "No response 60s after launch — the runtime may be misconfigured.",
        model: "claude-bogus",
      },
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    const text = rowText(renderer, "bot-activity-event-error")
    expect(text).toContain("No response 60s after launch")
    expect(text).toContain("handshake_timeout")
    expect(text).toContain("claude-bogus")
  })

  it("falls back gracefully when payload fields are missing", () => {
    const renderer = render({
      id: "e4",
      kind: "error",
      payload: {},
      sessionId: null,
      launchId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
    })
    const text = rowText(renderer, "bot-activity-event-error")
    expect(text).toContain("Something went wrong")
  })
})
