import { describe, expect, it, vi } from "vitest"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "./navigation-intent"

describe("navigation intent gate", () => {
  it("does not let a pending server resolution overwrite a Bot DM click captured at the shell root", async () => {
    let resolveServer!: (href: string) => void
    const pendingServer = new Promise<string>((resolve) => {
      resolveServer = resolve
    })
    const push = vi.fn()
    const gate = createNavigationIntentGate()
    const navigation = commitLatestNavigationIntent(
      gate,
      () => pendingServer,
      push,
    )

    const onShellClickCapture = () => supersedeNavigationIntent(gate)
    const onBotDmClick = () => push("/c/me/dm_2")

    onShellClickCapture()
    onBotDmClick()
    resolveServer("/c/channels/server_1/channel_1")

    await expect(navigation).resolves.toBe(false)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("/c/me/dm_2")
  })

  it("commits the latest resolved navigation", async () => {
    const push = vi.fn()
    const gate = createNavigationIntentGate()

    await expect(commitLatestNavigationIntent(
      gate,
      async () => "/c/channels/server_1/channel_1",
      push,
    )).resolves.toBe(true)

    expect(push).toHaveBeenCalledWith("/c/channels/server_1/channel_1")
  })
})
