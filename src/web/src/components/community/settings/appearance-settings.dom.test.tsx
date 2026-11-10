import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@/test/react-dom-harness"
import { AppearanceSettings } from "./appearance-settings"

const state = vi.hoisted(() => ({ theme: "system" as string | undefined, setTheme: vi.fn() }))
vi.mock("next-themes", () => ({ useTheme: () => state }))
beforeEach(() => { state.theme = "system"; state.setTheme.mockReset() })

it("keeps all theme choices distinct and changes only the chosen preference", () => {
  const view = render(<AppearanceSettings />)
  const group = screen.getByRole("group", { name: "Theme" })
  expect(within(group).getAllByRole("button")).toHaveLength(3)
  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true")
  fireEvent.click(screen.getByRole("button", { name: "Dark" }))
  expect(state.setTheme).toHaveBeenCalledExactlyOnceWith("dark")
  state.theme = "dark"
  view.rerender(<AppearanceSettings />)
  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false")
})
