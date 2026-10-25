import { expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { BotPiiPanel } from "./bot-pii-panel"

vi.mock("@/components/avatar", () => ({ AgentAvatar: ({ seed, avatarUrl }: { seed: string; avatarUrl?: string }) => <span data-testid="bot-avatar" data-seed={seed} data-image={avatarUrl} /> }))

it("pairs the selected bot name with its own avatar", () => {
  render(<BotPiiPanel bots={[{ id: "bot-1", name: "Alli", image: "/alli.png" }]} selectedId="bot-1" onSelect={vi.fn()}><p>Filters</p></BotPiiPanel>)
  expect(screen.getByTestId("pii-bot-select")).toHaveTextContent("Alli")
  expect(screen.getByTestId("bot-avatar")).toHaveAttribute("data-seed", "bot-1")
  expect(screen.getByTestId("bot-avatar")).toHaveAttribute("data-image", "/alli.png")
})
