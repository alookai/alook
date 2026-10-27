import { expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { DmHeaderSkeleton } from "./dm-header"

it("keeps Back usable while recipient identity has a local retry and disables only that retry in flight", () => {
  const back = vi.fn(), retry = vi.fn()
  const view = render(<DmHeaderSkeleton onBack={back} onRetryIdentity={retry} />)
  fireEvent.click(screen.getByRole("button", { name: "Retry recipient" }))
  expect(retry).toHaveBeenCalledOnce()
  const button = screen.getByRole("button", { name: "Retry recipient" })
  view.rerender(<DmHeaderSkeleton onBack={back} onRetryIdentity={retry} retryingIdentity />)
  expect(screen.getByRole("button", { name: "Retry recipient" })).toBe(button)
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  expect(back).toHaveBeenCalledOnce()
  view.unmount()
})
