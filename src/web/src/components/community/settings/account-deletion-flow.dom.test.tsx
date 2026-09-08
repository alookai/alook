import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { AccountDeletionFlow } from "./account-deletion-flow"

describe("AccountDeletionFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    document.elementFromPoint = vi.fn(() => null)
  })

  afterEach(async () => {
    await act(() => vi.runOnlyPendingTimersAsync())
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("does not send on open and never deletes when digit six is entered", async () => {
    const user = setupUser({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, expires_in: 300, resend_after: 60 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    const onDeleted = vi.fn().mockResolvedValue(undefined)
    render(<AccountDeletionFlow email="owner@example.com" onCancel={vi.fn()} onDeleted={onDeleted} />)

    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getByTestId(tid.accountDeletionSendCode))
    const input = await screen.findByTestId(tid.accountDeletionOtp)
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: "123456" } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onDeleted).not.toHaveBeenCalled()
    await user.click(screen.getByTestId(tid.accountDeletionSubmit))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/community/users/me/account-deletion",
      expect.objectContaining({ body: JSON.stringify({ otp: "123456" }) }),
    )
  })

  it("clears an invalid code, returns focus to the OTP, and preserves the resend cooldown after Back", async () => {
    const user = setupUser({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, expires_in: 300, resend_after: 60 }))
      .mockResolvedValueOnce(Response.json({ error: "INVALID_OTP" }, { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<AccountDeletionFlow email="owner@example.com" onCancel={vi.fn()} onDeleted={vi.fn()} />)

    await user.click(screen.getByTestId(tid.accountDeletionSendCode))
    const input = await screen.findByTestId(tid.accountDeletionOtp)
    fireEvent.change(input, { target: { value: "000000" } })
    await user.click(screen.getByTestId(tid.accountDeletionSubmit))

    await waitFor(() => {
      expect(input).toHaveValue("")
      expect(input).toHaveFocus()
    })
    expect(screen.getByRole("alert")).toHaveTextContent("That code is incorrect")

    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.getByRole("button", { name: "Send deletion code in 60s" })).toBeDisabled()
  })
})
