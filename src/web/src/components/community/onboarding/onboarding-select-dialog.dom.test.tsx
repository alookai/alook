import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { OnboardingSelectDialog } from "./onboarding-select-dialog"
import { OnboardingSurface } from "./onboarding-surface"

describe("agent selection", () => {
  it("advances directly from a selected option without a Continue button", () => {
    const submit = vi.fn()
    render(<OnboardingSurface><OnboardingSelectDialog open onOpenChange={() => {}} title="Choose an agent" options={[{ value: "codex", label: "Codex" }]} value="" onValueChange={() => {}} advanceOnSelect submitLabel="Continue" onSubmit={submit} /></OnboardingSurface>)
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: "Codex" }))
    expect(submit).toHaveBeenCalledExactlyOnceWith("codex")
  })
  it("keeps explicit submission for later choices", () => {
    const submit = vi.fn()
    render(<OnboardingSurface><OnboardingSelectDialog open onOpenChange={() => {}} title="Your role" options={[{ value: "work", label: "Work" }]} value="work" onValueChange={() => {}} submitLabel="Finish setup" onSubmit={submit} /></OnboardingSurface>)
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))
    expect(submit).toHaveBeenCalledExactlyOnceWith("work")
  })
})
