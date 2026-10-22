import { describe, it, expect } from "vitest"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { waitFor } from "@/test/react-dom-harness"
import { CommunityPreviewNavigation } from "../shell/community-preview-navigation"
import { MessageBody } from "./message-body"

describe("demo message rendering", () => {
  it("keeps diagram and formula syntax as text while retaining ordinary Markdown", async () => {
    const view = render(<CommunityPreviewNavigation value={true}><MessageBody text={"**Hello** $x^2$\n\n```mermaid\ngraph TD; A-->B\n```"} /></CommunityPreviewNavigation>)
    await waitFor(() => expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("Hello"))
    expect(view.container.textContent).toContain("$x^2$")
    expect(view.container.textContent).toContain("graph TD; A-->B")
    expect(view.container.querySelector(".katex, svg[aria-roledescription]")).toBeNull()
  })

  it("preserves ordinary text nodes while native plugins load", async () => {
    const view = render(<MessageBody text={"**Keep selected text**\n\n$x^2$"} />)
    const text = view.container.querySelector('[data-streamdown="strong"]')!
    expect(text.textContent).toBe("Keep selected text")
    await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull())
    expect(text.isConnected).toBe(true)
    expect(view.container.querySelector('[data-streamdown="strong"]')).toBe(text)
  })

  it("keeps native plain text visible while plugins load", () => {
    const view = render(<MessageBody text="Immediate plain message" />)
    expect(view.container.textContent).toContain("Immediate plain message")
  })

  it("keeps real chat formula rendering", async () => {
    const view = render(<MessageBody text={"$x^2$"} />)
    await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull())
  })
})
