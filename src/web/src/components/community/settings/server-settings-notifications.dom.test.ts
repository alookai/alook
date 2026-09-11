import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"

vi.mock("./settings-shell.module.css", () => ({ default: { shell: "settings-shell" } }))

vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => ({ bots: [] }),
}))

vi.mock("@/hooks/community/use-notification-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/community/use-notification-settings")>()
  return {
    ...actual,
    useBotNotificationSetting: () => ({ data: undefined, isError: false, isLoading: false }),
    useSetBotNotificationSetting: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

import { SettingsNotifications } from "./server-settings"

describe("SettingsNotifications server default", () => {
  const onSetLevel = vi.fn()

  beforeEach(() => {
    onSetLevel.mockReset()
  })

  it("shows All Messages for no setting row and sends the first explicit choice", async () => {
    const user = setupUser()
    render(createElement(SettingsNotifications, {
      serverId: "server_no_setting",
      level: undefined,
      onSetLevel,
    }))

    const all = screen.getByRole("button", { name: /Every message/ })
    const mentions = screen.getByRole("button", { name: /Mentions only/ })
    expect(all).toHaveClass("bg-accent")
    expect(mentions).not.toHaveClass("bg-accent")

    await user.click(mentions)
    expect(onSetLevel).toHaveBeenCalledOnce()
    expect(onSetLevel).toHaveBeenCalledWith("Only @mentions")
  })
})
