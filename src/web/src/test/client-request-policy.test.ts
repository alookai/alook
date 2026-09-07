import { describe, expect, it } from "vitest"
import { isClientMutationRequest } from "./e2e-ui/_fixtures/client-request-policy"

describe("E2E client request policy", () => {
  it.each([
    ["GET", "/api/community/users/me/inbox/unreads"],
    ["POST", "/api/community/messages/batch"],
    ["POST", "/api/community/messages/tags/batch"],
    ["POST", "/api/community/channels/participants/batch"],
    ["POST", "/api/community/replica/bootstrap"],
    ["POST", "/api/community/replica/delta"],
  ])("treats %s %s as read-only", (method, pathname) => {
    expect(isClientMutationRequest(method, pathname)).toBe(false)
  })

  it("never hides Replica intents from mutation assertions", () => {
    expect(isClientMutationRequest("POST", "/api/community/replica/intents")).toBe(true)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "treats ordinary %s requests as mutations",
    (method) => {
      expect(isClientMutationRequest(method, "/api/community/example")).toBe(true)
    },
  )
})
