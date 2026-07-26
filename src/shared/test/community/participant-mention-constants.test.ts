import { describe, it, expect, expectTypeOf } from "vitest"
import {
  PARTICIPANT_SOURCE,
  MENTION_KIND,
  type ParticipantSource,
  type MentionKind,
} from "../../src/constants/community"
import type { ThreadParticipantSource } from "../../src/db/queries/community/thread"
import { communityThreadParticipant, communityMention } from "../../src/db/community-schema"

// H6 — the value constants must not drift from the type aliases they derive,
// and the DB-default columns must resolve to the exact constant values.

describe("PARTICIPANT_SOURCE", () => {
  it("carries the three participant-source values", () => {
    expect(PARTICIPANT_SOURCE.MENTION).toBe("mention")
    expect(PARTICIPANT_SOURCE.SPOKE).toBe("spoke")
    expect(PARTICIPANT_SOURCE.ADDED).toBe("added")
  })

  it("ThreadParticipantSource is the same type as ParticipantSource (no drift)", () => {
    expectTypeOf<ThreadParticipantSource>().toEqualTypeOf<ParticipantSource>()
    expectTypeOf<ParticipantSource>().toEqualTypeOf<"mention" | "spoke" | "added">()
  })

  it("community_thread_participant.source DB default equals PARTICIPANT_SOURCE.MENTION", () => {
    expect(communityThreadParticipant.source.default).toBe(PARTICIPANT_SOURCE.MENTION)
  })
})

describe("MENTION_KIND", () => {
  it("carries the two mention-kind values", () => {
    expect(MENTION_KIND.MENTION).toBe("mention")
    expect(MENTION_KIND.REPLY).toBe("reply")
  })

  it("MentionKind derives from MENTION_KIND (no drift)", () => {
    expectTypeOf<MentionKind>().toEqualTypeOf<"mention" | "reply">()
  })

  it("community_mention.kind DB default equals MENTION_KIND.MENTION", () => {
    expect(communityMention.kind.default).toBe(MENTION_KIND.MENTION)
  })
})
