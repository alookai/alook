import { expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { AutomationSetupPrompt } from "./automation-setup-prompt"

it("copies the visible setup prompt for any agent without requiring a bot", async () => {
  const user = setupUser()
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
  render(<AutomationSetupPrompt />)
  const prompt = screen.getByRole("textbox", { name: "Automation setup prompt" })
  expect(prompt).toHaveAttribute("aria-readonly", "true")
  expect(prompt.textContent).toContain("https://alook.ai/agent.md")
  expect(prompt.textContent).toContain("permissions and limits")
  expect(screen.getByText(/paste it into any agent/)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Copy prompt" }))
  expect(copy).toHaveBeenCalledWith(prompt.textContent)
  expect(screen.getByRole("status")).toHaveTextContent("Prompt copied")
})

it("keeps the prompt selectable when clipboard access fails", async () => {
  const user = setupUser()
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"))
  render(<AutomationSetupPrompt />)
  const prompt = screen.getByRole("textbox", { name: "Automation setup prompt" })
  const value = prompt.textContent
  await user.click(screen.getByRole("button", { name: "Copy prompt" }))
  expect(screen.getByRole("status")).toHaveTextContent("Copy failed. Select the prompt and copy it manually.")
  expect(prompt).toBeEnabled()
  prompt.focus()
  const range = document.createRange()
  range.selectNodeContents(prompt)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  expect(window.getSelection()?.toString()).toBe(value)
  expect(prompt.textContent).toBe(value)
})
