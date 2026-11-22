import { buildDecisionCardEmbed, DecisionCardInputSchema } from "@alook/shared"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { Message } from "./message"

vi.mock("@/lib/community-db/projections", async (original) => ({
  ...await original<typeof import("@/lib/community-db/projections")>(),
  useCanonicalCommunityProfile: () => undefined,
}))

function mount() {
  return renderCommunity(<><textarea aria-label="Draft" defaultValue="keep my draft" />{["a", "b"].map(id =>
    <Message key={id} m={{ id, type: "chat", content: `Message ${id}`, grouped: false }} hoverCapable={false} onOpenThread={() => {}} onReply={() => {}} />,
  )}</>)
}
function start(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerType: "touch", button: 0, pointerId: 1 })
  fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 20, clientY: 20 }] })
}
function end(target: HTMLElement) {
  fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 1 })
  fireEvent.touchEnd(target)
  fireEvent.mouseDown(target)
  fireEvent.mouseUp(target)
  fireEvent.click(target)
}

describe("mobile message tap dismissal", () => {
  it("uses focus at touch start even if the browser blurs before click, then permits the next tap", async () => {
    const ui = mount()
    const editor = ui.getByRole("textbox")
    const row = ui.getByText("Message a")
    act(() => editor.focus())
    start(row)
    act(() => editor.blur())
    end(row)
    expect(ui.queryByRole("menu")).toBeNull()
    expect(editor).toHaveValue("keep my draft")
    start(row); end(row)
    await waitFor(() => expect(ui.getByRole("menu")).toBeVisible())
  })

  it("blurs a focused editor without opening a menu", () => {
    const ui = mount()
    const editor = ui.getByRole("textbox")
    act(() => editor.focus())
    const row = ui.getByText("Message a")
    start(row); end(row)
    expect(editor).not.toHaveFocus()
    expect(ui.queryByRole("menu")).toBeNull()
  })

  it("keeps attachment controls active when the editor is focused", () => {
    const onPreviewImage = vi.fn()
    const ui = renderCommunity(<><textarea aria-label="Draft" /><Message
      m={{ id: "image", type: "chat", content: "", grouped: false, attachments: [{ kind: "image", name: "photo.png", url: "/original" }] }}
      hoverCapable={false} onOpenThread={() => {}} onReply={() => {}} onPreviewImage={onPreviewImage}
    /></>)
    act(() => ui.getByRole("textbox").focus())
    const image = ui.getByRole("img", { name: "photo.png" })
    start(image); end(image)
    expect(onPreviewImage).toHaveBeenCalledOnce()
    expect(ui.queryByRole("menu")).toBeNull()
  })

  it("lets option text select a Decision Card answer even with a focused draft", async () => {
    const decisionCard = buildDecisionCardEmbed(DecisionCardInputSchema.parse({
      summary: "Ship date",
      questions: [{
        question: "When should we ship?",
        options: [{ label: "Today" }, { label: "Tomorrow" }],
      }],
    }), [{ userId: "viewer", handle: "viewer#0001" }])
    const ui = renderCommunity(<>
      <textarea aria-label="Draft" defaultValue="keep my draft" />
      <Message
        m={{ id: "question", type: "chat", grouped: false, decisionCard }}
        viewerUserId="viewer"
        hoverCapable={false}
        onReply={() => {}}
        onSubmitDecisionCard={async () => ({ replyToId: "question" })}
      />
      <Message
        m={{ id: "chat", type: "chat", grouped: false, content: "Regular message" }}
        hoverCapable={false}
        onReply={() => {}}
      />
    </>)

    const editor = ui.getByRole("textbox")
    act(() => editor.focus())
    const option = ui.getByText("Today")
    start(option); end(option)

    expect(ui.getByRole("radio", { name: "Today" })).toHaveAttribute("aria-checked", "true")
    expect(ui.getByRole("button", { name: "Send answer" })).toBeEnabled()
    expect(ui.queryByRole("menu")).toBeNull()
    expect(editor).toHaveValue("keep my draft")

    act(() => editor.blur())
    const message = ui.getByText("Regular message")
    start(message); end(message)
    await waitFor(() => expect(ui.getByRole("menu")).toBeVisible())
  })

  it("closes the first menu without opening the next message menu on the same touch", async () => {
    const ui = mount()
    const first = ui.getByText("Message a"), second = ui.getByText("Message b")
    start(first); end(first)
    await waitFor(() => expect(ui.getByRole("menu")).toBeVisible())
    start(second); end(second)
    await waitFor(() => expect(ui.queryByRole("menu")).toBeNull())
    start(second); end(second)
    await waitFor(() => expect(ui.getByRole("menu")).toBeVisible())
  })
})
