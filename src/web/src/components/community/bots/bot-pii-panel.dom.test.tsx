import { expect, it, vi } from "vitest"
import { act, render, screen, within, setupUser } from "@/test/react-dom-harness"
import { BotPiiPanel } from "./bot-pii-panel"

vi.mock("@/components/avatar", () => ({ AgentAvatar: ({ seed, avatarUrl }: { seed: string; avatarUrl?: string }) => <span data-testid="bot-avatar" data-seed={seed} data-image={avatarUrl} /> }))

it("pairs the selected bot name with its own avatar", () => {
  render(<BotPiiPanel bots={[{ id: "bot-1", name: "Alli", image: "/alli.png" }]} selectedId="bot-1" onSelect={vi.fn()}><p>Filters</p></BotPiiPanel>)
  expect(screen.getByTestId("pii-bot-select")).toHaveTextContent("Alli")
  expect(screen.getByTestId("bot-avatar")).toHaveAttribute("data-seed", "bot-1")
  expect(screen.getByTestId("bot-avatar")).toHaveAttribute("data-image", "/alli.png")
})

it("scopes the bot selector and its change action to the PII Filters tab", async () => {
  const user = setupUser()
  const onSelect = vi.fn()
  const view = render(<BotPiiPanel bots={[{ id: "a", name: "First" }, { id: "b", name: "Second" }]} selectedId="a" onSelect={onSelect}><p>Pipeline content</p></BotPiiPanel>)
  const panel = screen.getByRole("tabpanel", { name: "PII Filters" })
  expect(within(panel).getByText("Filter sensitive information from messages your bot sends to Alook. Messages people send to your bot are not filtered. All filtering runs on your computer.")).toBeVisible()
  const selector = within(panel).getByTestId("pii-bot-select")
  expect(view.container.querySelector("header")).not.toContainElement(selector)
  expect(within(panel).getByText("Pipeline content")).toBeVisible()
  await user.click(selector)
  await user.click(await screen.findByRole("option", { name: "Second" }))
  expect(onSelect).toHaveBeenCalledWith("b")
})

it("keeps pointer selection valid when opening waits for the browser animation frame", async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const user = setupUser()
  const onSelect = vi.fn()
  const view = render(<BotPiiPanel bots={[{ id: "a", name: "First" }, { id: "b", name: "Second" }]} selectedId="a" onSelect={onSelect}><p>Pipeline content</p></BotPiiPanel>)
  try {
    const panel = screen.getByRole("tabpanel", { name: "PII Filters" })
    const selector = within(panel).getByRole("combobox", { name: "Bot" })
    await user.click(selector)
    expect(frames.size).toBeGreaterThan(0)
    expect(selector).toHaveAttribute("aria-expanded", "false")
    expect(() => screen.getByRole("option", { name: "Second" })).toThrow()
    expect(onSelect).not.toHaveBeenCalled()
    await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    })
    const second = await screen.findByRole("option", { name: "Second" })
    expect(selector).toHaveAttribute("aria-expanded", "true")
    await user.click(second)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b")
  } finally {
    view.unmount()
    frames.clear()
    cancel.mockRestore()
    request.mockRestore()
  }
})
