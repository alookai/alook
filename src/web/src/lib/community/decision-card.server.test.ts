import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DECISION_CARD_MESSAGE_TYPE,
  DecisionCardInputSchema,
  queries,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import { prepareBotDecisionCard } from "./decision-card.server"

const readProfiles = vi.hoisted(() => vi.fn())
vi.mock("./resource-profiles.server", () => ({
  readCommunityResourceProfiles: readProfiles,
}))

const db = {} as Database

describe("decision-card.server", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    readProfiles.mockReset()
  })

  it("rejects sending a decision card as a forum opener", async () => {
    const input = DecisionCardInputSchema.parse({
      summary: "Confirm ship",
      questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
    })
    const result = await prepareBotDecisionCard(db, { kind: "forum", channelId: "f1", serverId: "s1" }, input)
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "decision cards cannot open a forum post; send inside the post thread instead",
    })
  })

  it("assigns the DM peer automatically without mention rows", async () => {
    readProfiles.mockResolvedValueOnce([{ id: "u_gus", name: "gus", discriminator: "1813" }])
    const input = DecisionCardInputSchema.parse({
      mentions: ["@someone_else#9999"],
      summary: "Quick call",
      questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
    })
    const result = await prepareBotDecisionCard(
      db,
      { kind: "dm", channelId: "dm1", otherUserId: "u_gus" },
      input,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.type).toBe(DECISION_CARD_MESSAGE_TYPE)
    expect(result.explicitMentionedUserIds).toEqual([])
    expect(result.content).toBe("Quick call")
    expect(JSON.parse(result.embeds)).toEqual([
      expect.objectContaining({
        kind: "decision_card",
        assignees: [{ userId: "u_gus", handle: "gus#1813" }],
      }),
    ])
  })

  it("resolves explicit channel mentions via targeted handle lookup and rejects outsiders without full-roster scans", async () => {
    const listMembersSpy = vi.spyOn(queries.communityMember, "listMembers")
    const fullAudienceSpy = vi.spyOn(queries.communityChannel, "getPrivateChannelAudienceUserIds")
    const findByHandlesSpy = vi.spyOn(queries.communityMember, "findServerMembersByHandles").mockResolvedValue([
      { userId: "u_gus", userName: "gus", discriminator: "1813" },
      { userId: "u_outsider", userName: "outsider", discriminator: "0001" },
    ])
    const filterVisibleSpy = vi.spyOn(queries.communityChannel, "filterChannelVisibleUserIds").mockResolvedValue(
      new Set(["u_gus"]),
    )

    const okInput = DecisionCardInputSchema.parse({
      mentions: ["@gus#1813", "GUS#1813"],
      summary: "Confirm mention lookup",
      questions: [{ question: "Ask @outsider#0001?", options: [{ label: "Yes" }, { label: "No" }] }],
    })
    const ok = await prepareBotDecisionCard(db, { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "s1" }, okInput)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.explicitMentionedUserIds).toEqual(["u_gus"])
    }
    expect(findByHandlesSpy).toHaveBeenCalledOnce()
    expect(filterVisibleSpy).toHaveBeenCalledOnce()
    expect(listMembersSpy).not.toHaveBeenCalled()
    expect(fullAudienceSpy).not.toHaveBeenCalled()

    const deniedInput = DecisionCardInputSchema.parse({
      mentions: ["@outsider#0001"],
      summary: "Confirm ship",
      questions: [{ question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }],
    })
    const denied = await prepareBotDecisionCard(db, { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "s1" }, deniedInput)
    expect(denied).toEqual({
      ok: false,
      status: 400,
      error: 'mention "@outsider#0001" is not a member of this channel',
    })
  })
})
