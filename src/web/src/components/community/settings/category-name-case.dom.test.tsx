import React from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { CreateCategoryDialog } from "./create-category-dialog"
import { CategorySettingsDialog } from "./category-settings-dialog"

describe.each(["create", "rename"] as const)("category %s name", mode => {
  function mount() {
    const submit = vi.fn()
    const close = vi.fn()
    render(mode === "create"
      ? <CreateCategoryDialog onCreate={submit} onClose={close} />
      : <CategorySettingsDialog name="Existing Name" isPrivate={false} onSave={submit} onClose={close} />)
    return { submit, close, input: screen.getByRole("textbox", { name: "Category name" }),
      button: screen.getByRole("button", { name: mode === "create" ? "Create category" : "Save" }) }
  }

  it.each(["  work  ", "DevOps", "中文 Mix"])("submits %s without changing its case", value => {
    const { submit, close, input, button } = mount()
    fireEvent.change(input, { target: { value } })
    fireEvent.click(button)
    expect(submit.mock.calls).toEqual(mode === "create" ? [[value.trim(), { private: false }]] : [[value.trim()]])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("retains blank validation", () => {
    const { submit, close, input, button } = mount()
    fireEvent.change(input, { target: { value: "   " } })
    expect(button).toBeDisabled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(submit).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("also preserves case on Enter", () => {
    const { submit, input } = mount()
    fireEvent.change(input, { target: { value: "  Team chat  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(submit.mock.calls[0]?.[0]).toBe("Team chat")
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
