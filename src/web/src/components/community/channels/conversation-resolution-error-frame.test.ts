import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"

describe("ConversationResolutionErrorFrame", () => {
  it.each([false, true])("keeps a persistent accessible error and retry control while retrying=%s", (retrying) => {
    const markup = renderToStaticMarkup(createElement(ConversationResolutionErrorFrame, { retrying, onRetry: () => {} }))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain("verify this conversation")
    expect(markup).toContain(retrying ? "Retrying…" : "Retry")
    expect(markup.includes('disabled=""')).toBe(retrying)
    expect(markup).toContain('type="button"')
    expect(markup).not.toMatch(/<(?:header|form|textarea)\b|data-slot="skeleton"|\sinert(?:=|\s)|composer/)
  })
})
