import { expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"

it("keeps retry accessible and blocks duplicate requests", () => {
  const onRetry = vi.fn()
  const view = render(<ConversationResolutionErrorFrame retrying={false} onRetry={onRetry} />)
  expect(view.getByRole("alert")).toHaveTextContent("Check your connection and try again.")
  fireEvent.click(view.getByRole("button", { name: "Retry" }))
  expect(onRetry).toHaveBeenCalledTimes(1)
  view.rerender(<ConversationResolutionErrorFrame retrying onRetry={onRetry} />)
  const pending = view.getByRole("button", { name: "Retrying…" })
  expect(pending).toBeDisabled()
  fireEvent.click(pending)
  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(view.getByRole("alert")).toHaveTextContent("Couldn't verify this conversation")
})
