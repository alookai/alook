import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ConversationResolutionPendingFrame } from "./conversation-resolution-pending-frame"

describe("ConversationResolutionPendingFrame", () => {
  it("covers the unresolved main panel with one square shared Skeleton", () => {
    const markup = renderToStaticMarkup(createElement(ConversationResolutionPendingFrame))

    expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(1)
    expect(markup).toMatch(/data-slot="skeleton" class="[^"]*animate-pulse[^"]*"/)
    expect(markup).toMatch(/data-slot="skeleton" class="[^"]*h-full[^"]*w-full[^"]*rounded-none[^"]*"/)
    expect(markup).not.toMatch(/rounded-(?:sm|md|lg|xl|2xl|3xl|full)(?:\s|")/)
  })

  it("stays inert and exposes no speculative conversation content", () => {
    const markup = renderToStaticMarkup(createElement(ConversationResolutionPendingFrame))

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Resolving conversation"')
    expect(markup).toContain('data-community-conversation-subtype="unknown"')
    expect(markup).toContain('<span class="sr-only">Resolving conversation</span>')
    expect(markup).not.toMatch(/<(?:header|button|a|form|textarea)\b/)
    expect(markup).not.toMatch(/Message|Forum|Thread|composer|previous channel/i)
  })
})
