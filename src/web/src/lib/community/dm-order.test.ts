import { describe, expect, it } from "vitest"
import { sortDmsByActivity } from "./dm-order"

describe("DM sidebar order", () => {
  it("sorts recent activity first and uses channel id as the stable tie-break", () => {
    expect(sortDmsByActivity([
      { id: "dm-z", activityAt: "2026-09-27T02:00:00.000Z" },
      { id: "dm-b", activityAt: "2026-09-27T03:00:00.000Z" },
      { id: "dm-a", activityAt: "2026-09-27T03:00:00.000Z" },
    ]).map((dm) => dm.id)).toEqual(["dm-a", "dm-b", "dm-z"])
  })

  it("does not let unread presentation reorder equal-activity conversations", () => {
    expect(sortDmsByActivity([
      { id: "dm-b", activityAt: "2026-09-27T03:00:00.000Z", unread: true },
      { id: "dm-a", activityAt: "2026-09-27T03:00:00.000Z", unread: false },
    ]).map((dm) => dm.id)).toEqual(["dm-a", "dm-b"])
  })

  it("matches SQLite BINARY ordering for equal-activity mixed-case nanoids", () => {
    const activityAt = "2026-09-27T03:00:00.000Z"

    expect(sortDmsByActivity([
      { id: "kMRip4KDm4Ki2HU8vQ2qd", activityAt },
      { id: "bc02tEwQaazjdPwrMuNih", activityAt },
      { id: "XzKeKetmiRMJ16hwOrhSl", activityAt },
      { id: "3kY1MAppCm6RYM4IvnXPN", activityAt },
    ]).map((dm) => dm.id)).toEqual([
      "3kY1MAppCm6RYM4IvnXPN",
      "XzKeKetmiRMJ16hwOrhSl",
      "bc02tEwQaazjdPwrMuNih",
      "kMRip4KDm4Ki2HU8vQ2qd",
    ])
  })
})
