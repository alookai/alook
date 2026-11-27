import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { OpenArtifactCard } from "./open-artifact-card"
import { tid } from "@/lib/community/testids"

describe("OpenArtifactCard", () => {
  it("renders Document and Slides cards and invokes onOpen when clicked", () => {
    const onOpen = vi.fn()
    const docPage = { kind: "alook_page" as const, id: "pg_doc", type: "doc", title: "Q4 Launch Brief" }
    const slidesPage = { kind: "alook_page" as const, id: "pg_deck", type: "slides", title: "Design Review" }

    render(
      <div>
        <OpenArtifactCard page={docPage} sourceMessageId="msg_doc_1" onOpen={onOpen} />
        <OpenArtifactCard page={slidesPage} onOpen={onOpen} />
      </div>,
    )

    const docBtn = screen.getByTestId(tid.openArtifactCard("pg_doc"))
    const slidesBtn = screen.getByTestId(tid.openArtifactCard("pg_deck"))

    expect(docBtn.textContent).toContain("Q4 Launch Brief")
    expect(docBtn.textContent).toContain("Document")
    expect(slidesBtn.textContent).toContain("Design Review")
    expect(slidesBtn.textContent).toContain("Slides")

    fireEvent.click(docBtn)
    fireEvent.click(slidesBtn)
    expect(onOpen).toHaveBeenNthCalledWith(1, { ...docPage, sourceMessageId: "msg_doc_1" })
    expect(onOpen).toHaveBeenNthCalledWith(2, slidesPage)
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
