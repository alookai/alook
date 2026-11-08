import { describe, expect, it } from "vitest"
import { resolveInviteCardPresentation } from "./community-invite-card"

describe("resolveInviteCardPresentation", () => {
  it("keeps sender state stable and non-interactive", () => {
    expect(resolveInviteCardPresentation("sender", false)).toEqual({
      eyebrow: "Invite sent",
      action: null,
    })
    expect(resolveInviteCardPresentation("sender", true)).toEqual({
      eyebrow: "Invite sent",
      action: null,
    })
  })

  it("keeps the existing recipient actions", () => {
    expect(resolveInviteCardPresentation("recipient", false)).toEqual({
      eyebrow: "You've been invited to join",
      action: "join",
    })
    expect(resolveInviteCardPresentation("recipient", true)).toEqual({
      eyebrow: "You've been invited to join",
      action: "open",
    })
  })

  it("keeps shared images neutral and non-interactive", () => {
    expect(resolveInviteCardPresentation("neutral", false)).toEqual({
      eyebrow: "Server invite",
      action: null,
    })
  })
})
