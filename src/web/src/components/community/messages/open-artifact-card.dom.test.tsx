import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { OpenArtifactCard } from "./open-artifact-card"
import { tid } from "@/lib/community/testids"

describe("OpenArtifactCard", () => {
  it("renders a real cover image inside the convex plastic-glass frame with zero iframes and invokes onOpen", () => {
    const onOpen = vi.fn()
    const docPage = { kind: "alook_page" as const, id: "pg_doc", type: "doc", title: "Q4 Launch Brief" }
    const slidesPage = { kind: "alook_page" as const, id: "pg_deck", type: "slides", title: "Design Review" }

    const { container } = render(
      <div>
        <OpenArtifactCard page={docPage} sourceMessageId="msg_doc_1" onOpen={onOpen} />
        <OpenArtifactCard page={slidesPage} onOpen={onOpen} />
      </div>,
    )

    expect(container.querySelectorAll("iframe").length).toBe(0)

    const docBtn = screen.getByTestId(tid.openArtifactCard("pg_doc"))
    const slidesBtn = screen.getByTestId(tid.openArtifactCard("pg_deck"))

    expect(docBtn.textContent).toContain("Q4 Launch Brief")
    expect(docBtn.textContent).toContain("Document")
    expect(docBtn.getAttribute("data-page-type")).toBe("doc")
    expect(docBtn.getAttribute("data-has-cover")).toBe("true")
    expect(slidesBtn.textContent).toContain("Design Review")
    expect(slidesBtn.textContent).toContain("Slides")

    const docImg = docBtn.querySelector("img") as HTMLImageElement | null
    const slidesImg = slidesBtn.querySelector("img") as HTMLImageElement | null
    expect(docImg?.getAttribute("src")).toBe("/api/community/pages/pg_doc/cover?sourceMessageId=msg_doc_1")
    expect(docImg?.getAttribute("loading")).toBe("lazy")
    expect(docImg?.getAttribute("decoding")).toBe("async")
    expect(slidesImg?.getAttribute("src")).toBe("/api/community/pages/pg_deck/cover")

    fireEvent.click(docBtn)
    fireEvent.click(slidesBtn)
    expect(onOpen).toHaveBeenNthCalledWith(1, { ...docPage, sourceMessageId: "msg_doc_1" })
    expect(onOpen).toHaveBeenNthCalledWith(2, slidesPage)
  })

  it("falls back in-place to the lightweight type SVG on 404/onError and retries when sourceMessageId changes", () => {
    const types = [
      { type: "docs", expected: "docs" },
      { type: "slides", expected: "slides" },
      { type: "sheets", expected: "sheets" },
      { type: "whiteboard", expected: "whiteboard" },
      { type: "design", expected: "design" },
      { type: "data", expected: "data" },
      { type: "motion", expected: "motion" },
      { type: "design-system", expected: "design-system" },
      { type: "page", expected: "page" },
    ]
    const view = render(
      <OpenArtifactCard
        page={{ kind: "alook_page", id: "pg_nocover", type: "sheets", title: "Hiring Plan" }}
        sourceMessageId="msg_1"
      />,
    )

    const button = screen.getByTestId(tid.openArtifactCard("pg_nocover"))
    const img = button.querySelector("img") as HTMLImageElement
    expect(img).not.toBeNull()

    fireEvent.error(img)
    expect(button.getAttribute("data-has-cover")).toBe("false")
    expect(button.querySelector("img")).toBeNull()
    expect(button.querySelector('svg[data-fallback-kind="sheets"]')).not.toBeNull()

    view.rerender(
      <OpenArtifactCard
        page={{ kind: "alook_page", id: "pg_nocover", type: "sheets", title: "Hiring Plan" }}
        sourceMessageId="msg_2"
      />,
    )
    expect(button.getAttribute("data-has-cover")).toBe("true")
    expect(button.querySelector("img")?.getAttribute("src")).toBe(
      "/api/community/pages/pg_nocover/cover?sourceMessageId=msg_2",
    )

    for (const entry of types) {
      view.rerender(
        <OpenArtifactCard
          page={{ kind: "alook_page", id: `pg_${entry.expected}`, type: entry.type, title: entry.expected }}
        />,
      )
      const card = screen.getByTestId(tid.openArtifactCard(`pg_${entry.expected}`))
      expect(card.querySelector(`svg[data-fallback-kind="${entry.expected}"]`)).not.toBeNull()
    }
  })

  it("disables opening when disabled is true", () => {
    const onOpen = vi.fn()
    const docPage = { kind: "alook_page" as const, id: "pg_disabled", type: "doc", title: "Locked" }
    render(<OpenArtifactCard page={docPage} onOpen={onOpen} disabled />)

    const button = screen.getByTestId(tid.openArtifactCard("pg_disabled")) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
