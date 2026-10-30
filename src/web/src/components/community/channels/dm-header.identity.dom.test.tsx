import { expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { DmHeader, DmHeaderSkeleton } from "./dm-header"
import { tid } from "@/lib/community/testids"
import type { DM } from "@/lib/community/models/people"

it.each(["Peer", "Direct message", "Post"])("keeps the DM title slot unresolved until the real name %s arrives", name => {
  const back = vi.fn()
  const dm: DM = { id: "dm", userId: "peer", name: "Direct message", discriminator: "0042", avatar: "D", avatarVersion: 0, status: "offline", preview: "" }
  const view = render(<DmHeader dm={dm} onBack={back} titleState="pending" />)
  const header = screen.getByTestId(tid.dmHeader)
  const button = screen.getByRole("button", { name: "Back" })
  expect(screen.getByTestId(tid.messageHeaderTitleLoading)).toHaveClass("h-4", "w-32")
  expect(screen.queryByTestId(tid.dmHeaderTitle)).toBeNull()
  view.rerender(<DmHeader dm={{ ...dm, name, discriminator: "0042" }} onBack={back} titleState="ready" />)
  expect(screen.getByTestId(tid.dmHeader)).toBe(header)
  expect(screen.queryByTestId(tid.messageHeaderTitleLoading)).toBeNull()
  expect(screen.getByTestId(tid.dmHeaderTitle)).toHaveTextContent(`${name}#0042`)
  expect(screen.getByRole("button", { name: "Back" })).toBe(button)
  fireEvent.click(button)
  expect(back).toHaveBeenCalledOnce()
  view.unmount()
})

it("keeps a failed recipient name static and uses the existing recipient retry", () => {
  const retry = vi.fn()
  const dm: DM = { id: "dm", userId: "peer", name: "Direct message", discriminator: "0042", avatar: "D", avatarVersion: 0, status: "offline", preview: "" }
  const view = render(<DmHeader dm={dm} titleState="unavailable" onRetryIdentity={retry} />)
  const title = screen.getByRole("img", { name: "Title unavailable" })
  expect(title).not.toHaveClass("animate-pulse")
  expect(screen.queryByTestId(tid.dmHeaderTitle)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Retry recipient" }))
  expect(retry).toHaveBeenCalledOnce()
  view.rerender(<DmHeader dm={dm} titleState="unavailable" onRetryIdentity={retry} retryingIdentity />)
  expect(screen.getByRole("button", { name: "Retry recipient" })).toBeDisabled()
  expect(screen.getByRole("img", { name: "Title unavailable" })).toBe(title)
  view.unmount()
})

it.each(["pending", "unavailable"] as const)("keeps Back usable while recipient identity is %s and disables only its retry in flight", titleState => {
  const back = vi.fn(), retry = vi.fn()
  const view = render(<DmHeaderSkeleton titleState={titleState} onBack={back} onRetryIdentity={retry} />)
  fireEvent.click(screen.getByRole("button", { name: "Retry recipient" }))
  expect(retry).toHaveBeenCalledOnce()
  const button = screen.getByRole("button", { name: "Retry recipient" })
  view.rerender(<DmHeaderSkeleton titleState={titleState} onBack={back} onRetryIdentity={retry} retryingIdentity />)
  expect(screen.getByTestId(tid.messageHeaderTitleLoading)).toHaveAttribute("data-title-state", titleState)
  expect(screen.getByRole("button", { name: "Retry recipient" })).toBe(button)
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  expect(back).toHaveBeenCalledOnce()
  view.unmount()
})
