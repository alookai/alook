import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { resolveInviteCardPresentation } from "./community-invite-card"

const componentDirectory = dirname(fileURLToPath(import.meta.url))
const readComponent = (name: string) =>
  readFileSync(resolve(componentDirectory, name), "utf8")

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

describe("invite-card perspective wiring", () => {
  it("derives sender perspective from the message author and viewer", () => {
    const message = readComponent("message.tsx")

    expect(message).toContain("m.authorId === viewerUserId ? \"sender\" : \"recipient\"")
    expect(message).toContain("a.authorId !== b.authorId")
    expect(message).toContain("prev.viewerUserId === next.viewerUserId")
  })

  it("keeps Share as Image explicitly neutral", () => {
    const shareDialog = readComponent("message-share-dialog.tsx")

    expect(shareDialog).toContain('invitePerspective="neutral"')
  })
})
