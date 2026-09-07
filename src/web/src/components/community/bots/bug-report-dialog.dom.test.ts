import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, fireEvent, render as rtlRender } from "@/test/react-dom-harness"

function passthrough(name: string) {
  return function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement("div", { ...props, "data-mock": name }, children)
  }
}

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: passthrough("dialog"),
  AlertDialogAction: passthrough("action"),
  AlertDialogCancel: passthrough("cancel"),
  AlertDialogContent: passthrough("content"),
  AlertDialogDescription: passthrough("description"),
  AlertDialogFooter: passthrough("footer"),
  AlertDialogHeader: passthrough("header"),
  AlertDialogTitle: passthrough("title"),
}))

import { BugReportDialog } from "./bug-report-dialog"

const onConfirm = vi.fn()
const onOpenChange = vi.fn()

function render(overrides: Record<string, unknown> = {}) {
  return rtlRender(React.createElement(BugReportDialog, {
    bot: { id: "b2", name: "Maya" },
    open: true,
    phase: "confirm",
    isSubmitting: false,
    reportId: null,
    errorCode: null,
    onConfirm,
    onOpenChange,
    ...overrides,
  }))
}

function text(renderer: ReturnType<typeof rtlRender>): string {
  return renderer.container.textContent ?? ""
}

describe("BugReportDialog", () => {
  beforeEach(() => {
    onConfirm.mockReset()
    onOpenChange.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("explains the report in plain language before submit", () => {
    const renderer = render()
    const copy = text(renderer)

    expect(copy).toContain("only program logs needed to diagnose the problem")
    expect(copy).toContain("We won’t read or upload your agent’s local chat history or files.")
    expect(copy).toContain("7 days")
    for (const jargon of ["daemon", "FSM", "PII", "stderr", "allowlisted"]) {
      expect(copy).not.toContain(jargon)
    }
    expect(renderer.container.querySelectorAll("input")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("textarea")).toHaveLength(0)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("submits only from explicit confirmation and disables repeat confirmation", () => {
    const renderer = render()
    const submit = renderer.getByTestId("bot-report-problem-submit")
    expect(submit).toHaveTextContent("Confirm")
    fireEvent.click(submit)
    expect(onConfirm).toHaveBeenCalledTimes(1)

    const pending = render({ isSubmitting: true })
    expect(pending.container.querySelector('[data-testid="bot-report-problem-submit"]'))
      .toBeDisabled()
  })

  it("offers only Close after the report is uploaded", () => {
    const renderer = render({ phase: "uploaded", reportId: "dbr_test123" })

    expect(renderer.queryAllByTestId("bot-report-problem-submit")).toHaveLength(0)
    expect(text(renderer)).toContain("Close")
    expect(text(renderer)).not.toContain("Report another problem")
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("offers Close + Try again after timeout, never Report another problem", () => {
    const renderer = render({ phase: "timeout", reportId: "dbr_test123" })
    const submit = renderer.getByTestId("bot-report-problem-submit")
    expect(submit).toHaveTextContent("Try again")
    expect(text(renderer)).toContain("Close")
    expect(text(renderer)).not.toContain("Report another problem")
  })

  it("shows rate-limit title + body with Close only — no Try again that rehits the bucket", () => {
    const renderer = render({
      phase: "failed",
      reportId: null,
      errorCode: "rate_limited",
    })
    expect(text(renderer)).toContain("A report was sent recently")
    expect(text(renderer)).toContain("You can send another report in a minute.")
    expect(text(renderer)).not.toContain("Report failed")
    expect(text(renderer)).toContain("Close")
    expect(text(renderer)).not.toContain("Try again")
    expect(renderer.queryAllByTestId("bot-report-problem-submit")).toHaveLength(0)
  })

  it.each([
    ["network_error", "Unable to connect — check your network"],
    ["target_unavailable", "Diagnostics aren't available for this bot right now."],
    ["nonce_conflict", "That report already belongs to another bot. Try again."],
  ] as const)("shows semantic %s copy with Close + Try again", (errorCode, copy) => {
    const renderer = render({
      phase: "failed",
      reportId: null,
      errorCode,
    })
    expect(text(renderer)).toContain(copy)
    expect(text(renderer)).toContain("Close")
    expect(renderer.getByTestId("bot-report-problem-submit")).toHaveTextContent("Try again")
  })

  it.each([
    ["collecting", "Collecting diagnostics"],
    ["uploaded", "Report uploaded"],
    ["failed", "Report failed"],
    ["timeout", "Collection timed out"],
  ])("renders the %s state", (phase, expected) => {
    const renderer = render({
      phase,
      reportId: "dbr_test123",
      errorCode: phase === "failed" ? "offline" : null,
    })
    expect(renderer.getByTestId("bot-report-problem-status")).toBeInTheDocument()
    expect(text(renderer)).toContain(expected)
  })

  it("uses fixed safe failure copy and never renders arbitrary backend detail", () => {
    const renderer = render({
      phase: "failed",
      reportId: "dbr_offline",
      errorCode: "offline",
      errorDetail: "Bearer secret at /Users/private should leak",
    })
    expect(text(renderer)).toContain("Bring the daemon online")
    expect(text(renderer)).not.toContain("Bearer secret")
    expect(text(renderer)).not.toContain("/Users/private")
    expect(text(renderer)).not.toContain("Collecting diagnostics")
  })

  it("never renders storage metadata, checksum, download location, or machine id", () => {
    const renderer = render({
      phase: "uploaded",
      reportId: "dbr_test123",
      machineId: "cm_private_machine",
      objectKey: "reports/dbr_test123.ndjson.gz",
      objectExpiresAt: 9_999,
      url: "https://example.invalid/report",
      downloadUrl: "https://example.invalid/download",
      sha256: "a".repeat(64),
      checksum: "private-checksum",
    })
    const copy = text(renderer)
    expect(copy).toContain("dbr_test123")
    for (const forbidden of [
      "cm_private_machine",
      "reports/dbr_test123.ndjson.gz",
      "example.invalid",
      "private-checksum",
      "a".repeat(64),
    ]) expect(copy).not.toContain(forbidden)
  })

  it("labels and copies only the owner-safe report id after an explicit click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const renderer = render({ phase: "uploaded", reportId: "dbr_test123" })

    expect(text(renderer)).toContain("Report ID")
    expect(writeText).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(renderer.getByRole("button", { name: "Copy report ID" }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith("dbr_test123")
    expect(text(renderer)).toContain("Copied")
  })

  it("shows fixed recoverable feedback when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Bearer secret /Users/private"))
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const renderer = render({ phase: "uploaded", reportId: "dbr_test123" })

    await act(async () => {
      fireEvent.click(renderer.getByRole("button", { name: "Copy report ID" }))
      await Promise.resolve()
    })
    expect(text(renderer)).toContain("Couldn’t copy. Select the ID instead.")
    expect(text(renderer)).not.toContain("Bearer secret")
    expect(text(renderer)).not.toContain("/Users/private")
  })
})
