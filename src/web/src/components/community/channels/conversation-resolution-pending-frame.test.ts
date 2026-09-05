import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ConversationResolutionPendingFrame } from "./conversation-resolution-pending-frame"

describe("ConversationResolutionPendingFrame", () => {
  it("uses the shared unresolved main visual", () => {
    const markup = renderToStaticMarkup(createElement(ConversationResolutionPendingFrame))

    expect(markup.match(/data-community-unresolved-main=""/g)).toHaveLength(1)
    expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(1)
  })

  it("stays inert and exposes no speculative conversation content", () => {
    const markup = renderToStaticMarkup(createElement(ConversationResolutionPendingFrame))

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Resolving conversation"')
    expect(markup).toContain('data-community-conversation-subtype="unknown"')
    expect(markup).toContain('data-community-mobile-transition="suppress"')
    expect(markup).toContain('<span class="sr-only">Resolving conversation</span>')
    expect(markup).not.toMatch(/<(?:header|button|a|form|textarea)\b/)
    expect(markup).not.toMatch(/Message|Forum|Thread|composer|previous channel/i)
  })
})
