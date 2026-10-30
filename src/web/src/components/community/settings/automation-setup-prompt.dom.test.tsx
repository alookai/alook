import { expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { AutomationSetupPrompt } from "./automation-setup-prompt"

it("copies the visible setup prompt for any agent without requiring a bot", async () => {
  const user = setupUser()
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
  render(<AutomationSetupPrompt />)
  const prompt = screen.getByRole("textbox", { name: "Automation setup prompt" }) as HTMLInputElement
  expect(prompt).toHaveAttribute("readonly")
  expect(prompt.value).toContain("https://alook.ai/agent.md")
  expect(prompt.value).toContain("permissions and limits")
  expect(screen.getByText(/paste it into any agent/)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Copy prompt" }))
  expect(copy).toHaveBeenCalledWith(prompt.value)
  expect(screen.getByRole("status")).toHaveTextContent("Prompt copied")
})

it("keeps the prompt selectable when clipboard access fails", async () => {
  const user = setupUser()
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"))
  render(<AutomationSetupPrompt />)
  const prompt = screen.getByRole("textbox", { name: "Automation setup prompt" }) as HTMLInputElement
  const value = prompt.value
  await user.click(screen.getByRole("button", { name: "Copy prompt" }))
  expect(screen.getByRole("status")).toHaveTextContent("Copy failed. Select the prompt and copy it manually.")
  expect(prompt).toBeEnabled()
  prompt.focus()
  prompt.select()
  expect(prompt.selectionStart).toBe(0)
  expect(prompt.selectionEnd).toBe(value.length)
  expect(prompt.value).toBe(value)
})
