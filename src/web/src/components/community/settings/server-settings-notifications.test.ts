import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

function buttonText(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAll((child) => typeof child.children?.[0] === "string")
    .flatMap((child) => child.children.filter((value): value is string => typeof value === "string"))
    .join(" ")
}

describe("SettingsNotifications server default", () => {
  const onSetLevel = vi.fn()

  beforeEach(() => {
    onSetLevel.mockReset()
  })

  it("shows All Messages for no setting row and sends the first explicit choice", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(SettingsNotifications, {
          serverId: "server_no_setting",
          level: undefined,
          onSetLevel,
        }),
      )
    })

    const buttons = renderer.root.findAllByType("button")
    const all = buttons.find((button) => buttonText(button).includes("Every message"))
    const mentions = buttons.find((button) => buttonText(button).includes("Mentions only"))

    expect(all?.props.className.split(/\s+/)).toContain("bg-accent")
    expect(mentions?.props.className.split(/\s+/)).not.toContain("bg-accent")

    act(() => mentions?.props.onClick())
    expect(onSetLevel).toHaveBeenCalledOnce()
    expect(onSetLevel).toHaveBeenCalledWith("Only @mentions")
  })
})
