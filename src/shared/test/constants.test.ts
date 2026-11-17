import { describe, it, expect } from "vitest"
import { COMMUNITY_MACHINE_HEARTBEAT_MS, COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS } from "../src/constants"
import {
  NOTIF_LEVELS, NOTIFICATION_LEVEL_VALUES, notifLevelDisplay, normalizeNotifLevel,
  PARTICIPANT_SOURCE, MENTION_KIND,
} from "../src/constants/community"
import { communityMention } from "../src/db/community-schema"

describe("constants", () => {
  it("machine heartbeat < machine offline threshold", () =>
    expect(COMMUNITY_MACHINE_HEARTBEAT_MS).toBeLessThan(COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS))
  it("machine offline threshold is derived as 3× heartbeat", () =>
    expect(COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS).toBe(3 * COMMUNITY_MACHINE_HEARTBEAT_MS))
})

describe("notification-level bijection (single source)", () => {
  it("NOTIF_LEVELS values exactly match the DB enum NOTIFICATION_LEVEL_VALUES", () => {
    expect(NOTIF_LEVELS.map((l) => l.value)).toEqual([...NOTIFICATION_LEVEL_VALUES])
  })

  it("every level has a unique, non-empty display string (no drift/dupes)", () => {
    const displays = NOTIF_LEVELS.map((l) => l.display)
    expect(new Set(displays).size).toBe(displays.length)
    for (const d of displays) expect(d.length).toBeGreaterThan(0)
  })

  it("notifLevelDisplay maps each value to its display; unknown passes through", () => {
    expect(notifLevelDisplay("all")).toBe("All Messages")
    expect(notifLevelDisplay("mentions")).toBe("Only @mentions")
    expect(notifLevelDisplay("nothing")).toBe("Nothing")
    expect(notifLevelDisplay("bogus")).toBe("bogus")
  })

  it("normalizeNotifLevel round-trips display→value and value→value", () => {
    for (const l of NOTIF_LEVELS) {
      expect(normalizeNotifLevel(l.display)).toBe(l.value) // display → value
      expect(normalizeNotifLevel(l.value)).toBe(l.value)   // value → value (idempotent)
    }
  })

  it("normalizeNotifLevel/notifLevelDisplay are inverse for every level", () => {
    for (const l of NOTIF_LEVELS) {
      expect(normalizeNotifLevel(notifLevelDisplay(l.value))).toBe(l.value)
    }
  })

  it("normalizeNotifLevel falls back to 'all' (fail-open, NOT the old silent 'mentions' mute) on unknown input", () => {
    expect(normalizeNotifLevel("totally unknown")).toBe("all")
  })
})

describe("PARTICIPANT_SOURCE / MENTION_KIND (single source)", () => {
  it("PARTICIPANT_SOURCE carries the three participant-source values", () => {
    expect(PARTICIPANT_SOURCE.MENTION).toBe("mention")
    expect(PARTICIPANT_SOURCE.SPOKE).toBe("spoke")
    expect(PARTICIPANT_SOURCE.ADDED).toBe("added")
  })

  it("MENTION_KIND carries the two mention-kind values", () => {
    expect(MENTION_KIND.MENTION).toBe("mention")
    expect(MENTION_KIND.REPLY).toBe("reply")
  })

  // Guard against drift between the drizzle column defaults (which MUST be
  // literals in the schema) and the shared constants that now anchor them —
  // drizzle exposes the compiled default on the column object.
  it("community_mention.kind DB default equals MENTION_KIND.MENTION", () => {
    expect((communityMention.kind as { default?: unknown }).default).toBe(MENTION_KIND.MENTION)
  })

})
