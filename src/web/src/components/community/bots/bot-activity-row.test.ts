import { describe, it, expect } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

import { BotActivityRow } from "./bot-activity-row"
import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"

function render(event: AuditEvent): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(BotActivityRow, { event }))
  })
  return renderer
}

// Flatten a node's rendered children into a single string.
const flatten = (children: unknown): string => {
  if (typeof children === "string") return children
  if (Array.isArray(children)) return children.map(flatten).join("")
  if (children && typeof children === "object" && "props" in (children as any)) {
    return flatten((children as any).props.children)
  }
  return ""
}

function rowText(renderer: TestRenderer.ReactTestRenderer, testid: string): string {
  const node = renderer.root.find((n) => n.props?.["data-testid"] === testid)
  return flatten(node.props.children).replace(/\s+/g, " ").trim()
}

function modelRowText(renderer: TestRenderer.ReactTestRenderer): string {
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
