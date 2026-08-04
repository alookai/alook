import { describe, it, expect } from "vitest"
import {
  isMessageBearingSurface,
  isChannelType,
  CHANNEL_TRAITS,
  channelReach,
  reachIsParticipantSet,
  isStoredChannelType,
  channelVisibility,
  visibilityIsDmParticipant,
  type StoredChannelType,
} from "./community-roles"

describe("isMessageBearingSurface", () => {
  it("is true for surfaces that bear messages: text, forum_post, thread, dm", () => {
    expect(isMessageBearingSurface("text")).toBe(true)
    expect(isMessageBearingSurface("forum_post")).toBe(true)
    expect(isMessageBearingSurface("thread")).toBe(true)
    expect(isMessageBearingSurface("dm")).toBe(true)
  })

  it("is false for a forum top-level (a post index, not a message surface)", () => {
    expect(isMessageBearingSurface("forum")).toBe(false)
  })

  it("is false for null/undefined/unknown", () => {
    expect(isMessageBearingSurface(null)).toBe(false)
    expect(isMessageBearingSurface(undefined)).toBe(false)
    expect(isMessageBearingSurface("bogus")).toBe(false)
  })
})

describe("isChannelType (creatable top-level types)", () => {
  it("accepts only text and forum", () => {
    expect(isChannelType("text")).toBe(true)
    expect(isChannelType("forum")).toBe(true)
    expect(isChannelType("forum_post")).toBe(false)
    expect(isChannelType("thread")).toBe(false)
    expect(isChannelType("dm")).toBe(false)
  })
})

// B0 trait table — lock each type's trait values to today's hand-branched
// behavior (the assignments Ingaborg #41 enumerated from current code). This is
// the "scan enum assignment vs current code" gate as an executable assertion:
// a later refactor that silently flips a type's axis fails here. B0 is behavior-
// inert (nothing consumes CHANNEL_TRAITS until B1), so this is the only consumer
// today and the guard that the extraction stayed behavior-invariant.
describe("CHANNEL_TRAITS (B0 trait model)", () => {
  it("maps each stored channel type to its extracted trait values", () => {
    expect(CHANNEL_TRAITS).toEqual({
      text: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision" },
      forum: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision" },
      forum_post: { addressing: "by-child-name", visibility: "inherit-parent", reach: "participant-set", creation: "pure-create" },
      thread: { addressing: "by-root-seq", visibility: "inherit-parent", reach: "participant-set", creation: "get-or-create" },
      dm: { addressing: "by-peer-identity", visibility: "dm-participant", reach: "dm-pair", creation: "get-or-create" },
    })
  })

  it("each CreationTrait value names exactly one collision contract (Aigneis #45 / Blondie #49)", () => {
    // reject-on-collision = top-level 409/0-rows (idx_channel_server_name);
    // pure-create = forum_post bump→N distinct; get-or-create = thread/dm
    // fetch-winner. A value spanning two contracts has no single oracle.
    expect(CHANNEL_TRAITS.text.creation).toBe("reject-on-collision")
    expect(CHANNEL_TRAITS.forum.creation).toBe("reject-on-collision")
    expect(CHANNEL_TRAITS.forum_post.creation).toBe("pure-create")
    expect(CHANNEL_TRAITS.thread.creation).toBe("get-or-create")
    expect(CHANNEL_TRAITS.dm.creation).toBe("get-or-create")
  })

  it("covers every stored channel type (no type left un-traited)", () => {
    const types: StoredChannelType[] = ["text", "forum", "forum_post", "thread", "dm"]
    for (const t of types) expect(CHANNEL_TRAITS[t]).toBeDefined()
    expect(Object.keys(CHANNEL_TRAITS).sort()).toEqual([...types].sort())
  })

  it("addressing values are distinct per addressing strategy (no accidental reuse across strategies)", () => {
    // forum_post addresses by its own child name, thread by root seq — the two
    // must NOT share an addressing value (they resolve on different keys; a
    // shared value would collapse the resolver's two branches, the exact
    // do-not-fold the resolver comment warns about).
    expect(CHANNEL_TRAITS.forum_post.addressing).not.toBe(CHANNEL_TRAITS.thread.addressing)
  })
})

// B2 reach axis — the single-source classification the three reach faces (fanout
// recipients / inbox deliverable-narrowing / send-path enroll) share.
describe("reach axis helpers", () => {
  it("channelReach reads the reach value straight from the trait table", () => {
    expect(channelReach("text")).toBe("server-or-roster")
    expect(channelReach("forum")).toBe("server-or-roster")
    expect(channelReach("forum_post")).toBe("participant-set")
    expect(channelReach("thread")).toBe("participant-set")
    expect(channelReach("dm")).toBe("dm-pair")
  })

  it("reachIsParticipantSet is true for exactly thread + forum_post (the enroll ⟷ read shared predicate)", () => {
    expect(reachIsParticipantSet("thread")).toBe(true)
    expect(reachIsParticipantSet("forum_post")).toBe(true)
    expect(reachIsParticipantSet("text")).toBe(false)
    expect(reachIsParticipantSet("forum")).toBe(false)
    expect(reachIsParticipantSet("dm")).toBe(false)
  })

  it("reachIsParticipantSet tolerates the loose null/unknown types from the query layer", () => {
    expect(reachIsParticipantSet(null)).toBe(false)
    expect(reachIsParticipantSet(undefined)).toBe(false)
    expect(reachIsParticipantSet("bogus")).toBe(false)
  })

  it("isStoredChannelType guards the five stored types", () => {
    for (const t of ["text", "forum", "forum_post", "thread", "dm"]) expect(isStoredChannelType(t)).toBe(true)
    expect(isStoredChannelType(null)).toBe(false)
    expect(isStoredChannelType("channel")).toBe(false)
  })
})

// B3 visibility axis — how the access check resolves (NOT the miss status, which
// is surface-partitioned and stays in the caller's translation layer).
describe("visibility axis helpers", () => {
  it("channelVisibility reads the visibility value straight from the trait table", () => {
    expect(channelVisibility("text")).toBe("own-roster")
    expect(channelVisibility("forum")).toBe("own-roster")
    expect(channelVisibility("forum_post")).toBe("inherit-parent")
    expect(channelVisibility("thread")).toBe("inherit-parent")
    expect(channelVisibility("dm")).toBe("dm-participant")
  })

  it("visibilityIsDmParticipant is true for exactly dm (the shared DM access-rule predicate)", () => {
    expect(visibilityIsDmParticipant("dm")).toBe(true)
    expect(visibilityIsDmParticipant("text")).toBe(false)
    expect(visibilityIsDmParticipant("forum")).toBe(false)
    expect(visibilityIsDmParticipant("forum_post")).toBe(false)
    expect(visibilityIsDmParticipant("thread")).toBe(false)
  })

  it("visibilityIsDmParticipant tolerates the loose null/unknown types from the query layer", () => {
    expect(visibilityIsDmParticipant(null)).toBe(false)
    expect(visibilityIsDmParticipant(undefined)).toBe(false)
    expect(visibilityIsDmParticipant("bogus")).toBe(false)
  })
})
