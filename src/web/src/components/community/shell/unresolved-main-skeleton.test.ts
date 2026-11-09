import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { within } from "@testing-library/react/pure"
import { describe, expect, it } from "vitest"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

describe("UnresolvedMainSkeleton", () => {
  it("server-renders neutral loading status without blocking actions", () => {
    expect(typeof globalThis.window).toBe("undefined")
    expect(typeof globalThis.document).toBe("undefined")
    const markup = renderToStaticMarkup(createElement(UnresolvedMainSkeleton))
    const dom = new JSDOM(markup)
    try {
      const document = dom.window.document
      const statuses = within(document.body).getAllByRole("status")
      expect(statuses).toHaveLength(1)
      const status = statuses[0]
      expect(status.getAttribute("aria-label")).toBe("Loading")
      expect(status.getAttribute("aria-live")).toBe("polite")
      expect(status.getAttribute("aria-atomic")).toBe("true")
      expect(status.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
      expect(document.querySelector('button, input, a, [role="dialog"], [aria-modal="true"]')).toBeNull()
    } finally {
      dom.window.close()
    }
  })
})
