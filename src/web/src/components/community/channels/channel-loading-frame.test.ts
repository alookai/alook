import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import ServerLoading from "@/app/c/channels/[serverId]/loading"
import { ChannelLoadingFrame } from "./channel-loading-frame"

describe("ChannelLoadingFrame", () => {
  it.each([ChannelLoadingFrame, ServerLoading])("keeps the server route fallback neutral before its leaf is known: %s", (Component) => {
    const markup = renderToStaticMarkup(createElement(Component))

    expect(markup.match(/data-community-unresolved-main=""/g)).toHaveLength(1)
    expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(1)
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Loading conversation"')
    expect(markup).toContain('data-community-mobile-transition="suppress"')
    expect(markup).not.toMatch(/<(?:header|button|a|form|textarea)\b/)
    expect(markup).not.toMatch(/composer|message-list|channel-header/)
  })
})
