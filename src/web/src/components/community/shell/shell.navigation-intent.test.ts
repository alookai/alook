import { createElement } from "react"
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
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
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(
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
    })

    const shell = renderer.root.findAllByType("div").find(
      (node) => node.props["data-testid"] === "community-shell",
    )!
    const botDm = renderer.root.findByProps({ "data-testid": "bot-dm" })
    shell.props.onClickCapture({})
    botDm.props.onClick()
    resolveServer("/c/channels/server_1/channel_1")

    await expect(serverNavigation).resolves.toBe(false)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("/c/me/dm_2")
  })

  it("captures keyboard activation without treating navigation keys as intent", async () => {
    const onNavigationIntent = vi.fn()
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(createElement(Shell, {
        "data-testid": "community-shell",
        onNavigationIntent,
      }))
    })

    const shell = renderer.root.findAllByType("div").find(
      (node) => node.props["data-testid"] === "community-shell",
    )!
    shell.props.onKeyDownCapture({ key: "ArrowDown" })
    shell.props.onKeyDownCapture({ key: "Enter" })
    shell.props.onKeyDownCapture({ key: " " })

    expect(onNavigationIntent).toHaveBeenCalledTimes(2)
  })
})
