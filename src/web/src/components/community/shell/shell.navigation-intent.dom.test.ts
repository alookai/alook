import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import { Shell } from "./shell"

vi.mock("@/components/ui/app-surface", () => ({
  AppBackground: () => createElement("div", { "data-testid": "background" }),
}))

describe("Shell navigation intent capture", () => {
  it("cancels a pending server resolution before a nested Bot DM click runs", async () => {
    let resolveServer!: (href: string) => void
    const pendingServer = new Promise<string>((resolve) => {
      resolveServer = resolve
    })
    const push = vi.fn()
    const gate = createNavigationIntentGate()
    const serverNavigation = commitLatestNavigationIntent(
      gate,
      () => pendingServer,
      push,
    )
    render(createElement(
      Shell,
      {
        "data-testid": "community-shell",
        onNavigationIntent: () => supersedeNavigationIntent(gate),
      },
      createElement("button", {
        "data-testid": "bot-dm",
        onClick: () => push("/c/me/dm_2"),
      }),
    ))

    fireEvent.click(screen.getByTestId("bot-dm"))
    resolveServer("/c/channels/server_1/channel_1")

    await expect(serverNavigation).resolves.toBe(false)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("/c/me/dm_2")
  })

  it("captures keyboard activation without treating navigation keys as intent", async () => {
    const onNavigationIntent = vi.fn()
    render(createElement(Shell, {
      "data-testid": "community-shell",
      onNavigationIntent,
    }))

    const shell = screen.getByTestId("community-shell")
    fireEvent.keyDown(shell, { key: "ArrowDown" })
    fireEvent.keyDown(shell, { key: "Enter" })
    fireEvent.keyDown(shell, { key: " " })

    expect(onNavigationIntent).toHaveBeenCalledTimes(2)
  })
})
