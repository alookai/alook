import { createElement } from "react"
import { expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { CommunityAccountPendingFrame } from "./community-account-pending-frame"

vi.mock("./community-connecting-indicator", () => ({ CommunityConnectingIndicator: () => createElement("div", { role: "status" }, "Loading") }))

it("exposes the actual startup paint child to the existing theme publisher", () => {
  render(<CommunityAccountPendingFrame pathname="/c" />)
  const frame = screen.getByTestId(tid.initialFrame)
  expect(frame).toHaveAttribute("data-community-startup-frame")
  expect(frame.querySelector('[data-slot="community-frame-paint"]')).not.toBeNull()
  expect(frame.querySelector('[data-community-unresolved-main]')).not.toBeNull()
  expect(screen.getByRole("main", { name: "Resolving community route" })).toBe(screen.getByTestId(tid.pendingMain("route-resolution")))
  expect(screen.getAllByRole("main")).toHaveLength(1)
  expect(screen.getByTestId(tid.pendingMain("route-resolution"))).toHaveAttribute("data-community-main-kind", "route-resolution")
  expect(screen.getByRole("status")).toHaveTextContent("Loading")
})

it("keeps a supplied account error actionable and leaves the startup publication path", () => {
  const retry = vi.fn()
  render(<CommunityAccountPendingFrame pathname="/c/me"><div role="alert"><button onClick={retry}>Retry</button></div></CommunityAccountPendingFrame>)
  expect(screen.getByTestId(tid.initialFrame)).not.toHaveAttribute("data-community-startup-frame")
  expect(screen.getByRole("alert")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(retry).toHaveBeenCalledOnce()
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(screen.queryByTestId(tid.pendingMain("route-resolution"))).not.toBeInTheDocument()
})
