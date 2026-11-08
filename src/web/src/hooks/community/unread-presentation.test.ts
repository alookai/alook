import { describe, expect, it } from "vitest"

import { selectUnreadPresentation } from "./unread-presentation"

describe("unread presentation", () => {
  it("keeps one diagnostic decision snapshot for account, reservation, active, and mute policy", () => {
    expect({
      unread: selectUnreadPresentation({ accountUnread: true }),
      active: selectUnreadPresentation({ accountUnread: true, active: true }),
      muted: selectUnreadPresentation({ accountUnread: true, muted: true }),
      reserved: selectUnreadPresentation({ accountUnread: true, reserved: true }),
    }).toMatchInlineSnapshot(`
      {
        "active": {
          "accountUnread": true,
          "active": true,
          "effectiveUnread": true,
          "emphasize": false,
          "muted": false,
          "reserved": false,
          "showDot": false,
          "state": "active",
        },
        "muted": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": true,
          "emphasize": false,
          "muted": true,
          "reserved": false,
          "showDot": false,
          "state": "muted",
        },
        "reserved": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": false,
          "emphasize": false,
          "muted": false,
          "reserved": true,
          "showDot": false,
          "state": "reserved",
        },
        "unread": {
          "accountUnread": true,
          "active": false,
          "effectiveUnread": true,
          "emphasize": true,
          "muted": false,
          "reserved": false,
          "showDot": true,
          "state": "unread",
        },
      }
    `)
  })
})
