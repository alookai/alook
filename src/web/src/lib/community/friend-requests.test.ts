import { describe, expect, it } from "vitest"
import { actionableIncomingRequests, compactRequestCount } from "./friend-requests"
import type { PendingRequest } from "./models/people"

const request = (
  id: string,
  kind: PendingRequest["kind"],
  needsOwnerApproval: string | null | undefined,
): PendingRequest => ({
  id,
  userId: `user-${id}`,
  name: id,
  avatar: id,
  avatarVersion: 0,
  kind,
  needsOwnerApproval,
})

describe("actionableIncomingRequests", () => {
  it("treats an absent legacy response field as an empty list", () => {
    expect(actionableIncomingRequests(undefined)).toEqual([])
  })

  it("keeps only incoming rows without an owner gate", () => {
    expect(actionableIncomingRequests([
      request("incoming-null", "incoming", null),
      request("incoming-legacy", "incoming", undefined),
      request("incoming-gated", "incoming", "owner"),
      request("outgoing", "outgoing", null),
    ]).map((row) => row.id)).toEqual(["incoming-null", "incoming-legacy"])
  })
})

describe("compactRequestCount", () => {
  it.each([
    [0, null],
    [1, "1"],
    [99, "99"],
    [100, "99+"],
  ])("formats %i as %s", (count, expected) => {
    expect(compactRequestCount(count)).toBe(expected)
  })
})
