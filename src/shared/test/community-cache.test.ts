import { expect, it } from "vitest"
import { notificationSettingSchema } from "../src/community-cache"

it("requires exactly one current notification target and preserves the chosen scope", () => {
  const row = { id: "setting", level: "all" }
  expect(notificationSettingSchema.parse({ ...row, serverId: "server" })).toEqual({ ...row, serverId: "server" })
  expect(notificationSettingSchema.parse({ ...row, channelId: "channel", serverId: null })).toEqual({ ...row, channelId: "channel", serverId: null })
  for (const target of [{}, { serverId: null, channelId: null }, { serverId: "server", channelId: "channel" }]) {
    expect(notificationSettingSchema.safeParse({ ...row, ...target })).toMatchObject({ success: false, error: { issues: [expect.objectContaining({ message: "notification setting requires exactly one target" })] } })
  }
})
