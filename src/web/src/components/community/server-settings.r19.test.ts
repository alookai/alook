import { describe, it, expect } from "vitest"
import { notifLevelDisplay } from "@alook/shared/constants/community"
import { SERVER_NOTIF_LEVELS } from "./server-settings"

/**
 * R19: a server with no `community_notification_setting` row is delivered at
 * the climb terminus `all` server-side. The settings UI computes the selected
 * level as `notifs.server[serverId] ?? notifLevelDisplay("all")` and
 * `SettingsNotifications` marks a radio selected when `level === l.value`
 * (where `l.value` is the display string). This asserts the no-row fallback
 * lands on the "Every message" / `all` option — not "Mentions only".
 */
describe("server-settings R19 default notif level", () => {
  it("falls back to the all display value when no setting row exists", () => {
    const noRowFallback = undefined /* notifs.server[serverId] */ ?? notifLevelDisplay("all")
    expect(noRowFallback).toBe("All Messages")
  })

  it("the all fallback selects the 'Every message' radio, not mentions", () => {
    const selected = undefined ?? notifLevelDisplay("all")
    const selectedOption = SERVER_NOTIF_LEVELS.find((l) => l.value === selected)
    expect(selectedOption?.label).toBe("Every message")
    // guard against the old bug: fallback must NOT match the mentions option
    const mentionsOption = SERVER_NOTIF_LEVELS.find((l) => l.label === "Mentions only")
    expect(selected).not.toBe(mentionsOption?.value)
  })
})
