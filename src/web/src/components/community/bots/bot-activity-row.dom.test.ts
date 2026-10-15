import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import React from "react"
import { render as renderDom, setupUser, waitFor, within } from "@/test/react-dom-harness"

import { BotActivityRow } from "./bot-activity-row"
import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"

let mobile = false
beforeEach(() => {
  mobile = false
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width: 639px") && mobile, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })))
})
afterEach(() => vi.unstubAllGlobals())

function render(event: AuditEvent) {
  return renderDom(React.createElement(BotActivityRow, { event }))
}

function rowText(renderer: ReturnType<typeof renderDom>, testid: string): string {
  return renderer.getByTestId(testid).textContent!.replace(/\s+/g, " ").trim()
}

function modelRowText(renderer: ReturnType<typeof renderDom>): string {
  return rowText(renderer, "bot-activity-event-model_changed")
}

describe("BotActivityRow — text and historical thinking", () => {
  function textEvent(payload: unknown, kind: "text" | "thinking" = "text"): AuditEvent {
    return { id: "text-1", kind, payload, sessionId: null, launchId: null, createdAt: "2026-10-14T00:00:00.000Z" }
  }

  it("renders the retained Unicode body literally without interpreting markup", () => {
    const text = "正文🙂\n<script>private body</script>"
    const renderer = render(textEvent({ text, truncated: false, chars: [...text].length }))
    expect(renderer.getByTestId("bot-activity-event-text").textContent).toBe(text)
    expect(renderer.container.querySelector("script")).toBeNull()
    expect(renderer.container).not.toHaveTextContent("Truncated")
    expect(renderer.container.querySelector('[aria-label="text"]')).not.toBeNull()
  })

  it("shows retention truncation even when the short retained prefix fits the row", () => {
    const renderer = render(textEvent({ text: "short prefix", truncated: true, chars: 200 }))
    expect(renderer.getByTestId("bot-activity-event-text")).toHaveTextContent("short prefix")
    expect(renderer.getByTestId("bot-activity-event-text").querySelector("button")).toBeEnabled()
    expect(renderer.container).toHaveTextContent("Truncated")
  })

  it("keeps historical thinking readable without relabeling it as text", () => {
    const renderer = render(textEvent({ text: "retained thinking", truncated: false, chars: 17 }, "thinking"))
    expect(renderer.container).toHaveTextContent("retained thinking")
    expect(renderer.container.querySelector('[aria-label="think"]')).not.toBeNull()
    expect(renderer.container.querySelector('[data-testid="bot-activity-event-text"]')).toBeNull()
  })
})

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


describe("BotActivityRow native detail owners", () => {
  const detailEvent = (id: string, text: string): AuditEvent => ({ id, kind: "thinking", payload: { text }, sessionId: null, launchId: null, createdAt: "2026-10-14T00:00:00.000Z" })
  it("opens each desktop row's complete retained text with CSS-only row ellipsis", async () => {
    const first = "first row🙂\nfull second line", second = "other row content"
    const view = renderDom(React.createElement("div", null, React.createElement(BotActivityRow, { event: detailEvent("one", first) }), React.createElement(BotActivityRow, { event: detailEvent("two", second) })))
    const user = setupUser()
    const [one, two] = view.getAllByRole("button")
    expect(one.querySelector("span")).toHaveClass("truncate")
    expect(two.querySelector("span")).toHaveClass("truncate")
    await user.hover(one)
    await waitFor(() => expect(view.getByRole("tooltip").textContent).toBe(first))
    await user.unhover(one)
    await user.hover(two)
    await waitFor(() => expect(view.getByRole("tooltip").textContent).toBe(second))
    expect(view.getByRole("tooltip")).not.toHaveClass("truncate")
  })
  it("opens the exact mobile row in a dialog and returns focus on close", async () => {
    mobile = true
    const text = "mobile retained🙂\ncomplete content"
    const view = render(detailEvent("mobile", text)), user = setupUser()
    const trigger = view.getByRole("button")
    await user.click(trigger)
    const dialog = view.getByRole("dialog")
    expect(within(dialog).getByTestId("bot-activity-detail").textContent).toBe(text)
    expect(within(dialog).getByTestId("bot-activity-detail")).toHaveClass("whitespace-pre-wrap")
    expect(view.queryByRole("tooltip")).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
