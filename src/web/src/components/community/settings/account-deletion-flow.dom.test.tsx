import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { AccountDeletionFlow } from "./account-deletion-flow"

const authTransition = vi.hoisted(() => ({
  begin: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock("@/lib/api/client", () => ({
  ACCOUNT_DELETED_SIGN_IN_PATH: "/sign-in?account_deleted=1",
  beginAccountDeletionAuthTransition: authTransition.begin,
  cancelAccountDeletionAuthTransition: authTransition.cancel,
}))

describe("AccountDeletionFlow", () => {
  beforeEach(() => {
    authTransition.begin.mockReset()
    authTransition.cancel.mockReset()
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
    expect(authTransition.begin).toHaveBeenCalledTimes(1)
    expect(authTransition.begin.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1]!)
    expect(authTransition.cancel).not.toHaveBeenCalled()
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
    expect(authTransition.begin).toHaveBeenCalledTimes(1)
    expect(authTransition.cancel).toHaveBeenCalledTimes(1)
  })

  it("restores normal auth navigation when the deletion request cannot complete", async () => {
    const user = setupUser({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, expires_in: 300, resend_after: 60 }))
      .mockRejectedValueOnce(new TypeError("offline"))
    vi.stubGlobal("fetch", fetchMock)
    render(<AccountDeletionFlow email="owner@example.com" onCancel={vi.fn()} onDeleted={vi.fn()} />)

    await user.click(screen.getByTestId(tid.accountDeletionSendCode))
    const input = await screen.findByTestId(tid.accountDeletionOtp)
    fireEvent.change(input, { target: { value: "123456" } })
    await user.click(screen.getByTestId(tid.accountDeletionSubmit))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Check your connection"))
    expect(authTransition.begin).toHaveBeenCalledTimes(1)
    expect(authTransition.cancel).toHaveBeenCalledTimes(1)
  })

  it("falls back to the persistent completion URL when local cleanup rejects", async () => {
    const user = setupUser({ advanceTimers: (delay) => vi.advanceTimersByTime(delay) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, expires_in: 300, resend_after: 60 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    const replace = vi.fn()
    vi.stubGlobal("location", { replace })
    render(<AccountDeletionFlow
      email="owner@example.com"
      onCancel={vi.fn()}
      onDeleted={vi.fn().mockRejectedValue(new Error("cleanup"))}
    />)

    await user.click(screen.getByTestId(tid.accountDeletionSendCode))
    const input = await screen.findByTestId(tid.accountDeletionOtp)
    fireEvent.change(input, { target: { value: "123456" } })
    await user.click(screen.getByTestId(tid.accountDeletionSubmit))

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?account_deleted=1"))
    expect(authTransition.cancel).not.toHaveBeenCalled()
  })
})
