import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { FriendApprovalPayload } from "@alook/shared"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import { BotApprovalCard } from "./bot-approval-card"

const OTHER = { id: "u_alice", name: "Alice", discriminator: "0042", image: null }
const BOT = { id: "bot_zoe", name: "Zoe", discriminator: "0007", image: null }

function render(approval: FriendApprovalPayload): string {
  const client = new QueryClient()
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(BotApprovalCard, { approval })),
  )
}

function base(over: Partial<FriendApprovalPayload>): FriendApprovalPayload {
  return {
    friendshipId: "fr_1",
    status: "pending",
    waitingOn: "you",
    otherProfile: OTHER,
    botProfile: BOT,
    waitingOnProfile: null,
    ...over,
  }
}

describe("BotApprovalCard states", () => {
  it("pending + waitingOn=you → actionable with Approve/Deny", () => {
    const html = render(base({ status: "pending", waitingOn: "you" }))
    expect(html).toContain("Approve")
    expect(html).toContain("Deny")
    expect(html).toContain("Alice#0042")
    expect(html).toContain('data-approval-status="pending"')
  })

  it("pending + waitingOn=addressee → chip 'Approved — waiting on <name>', no buttons", () => {
    const html = render(base({ status: "pending", waitingOn: "addressee", waitingOnProfile: OTHER }))
    expect(html).toContain("Approved — waiting on Alice")
    expect(html).not.toContain(">Approve<")
    expect(html).not.toContain(">Deny<")
  })

  it("pending + waitingOn=other-owner → chip with the other owner's name", () => {
    const carol = { id: "u_carol", name: "Carol", discriminator: "0003", image: null }
    const html = render(base({ status: "pending", waitingOn: "other-owner", waitingOnProfile: carol }))
    expect(html).toContain("Approved — waiting on Carol")
  })

  it("accepted → 'Approved' chip", () => {
    const html = render(base({ status: "approved", waitingOn: null }))
    expect(html).toContain("Approved")
    expect(html).not.toContain(">Deny<")
  })

  it("denied → 'Denied' chip", () => {
    const html = render(base({ status: "denied", waitingOn: null }))
    expect(html).toContain("Denied")
  })

  it("superseded → 'Replaced by a newer request'", () => {
    const html = render(base({ status: "superseded", waitingOn: null }))
    expect(html).toContain("Replaced by a newer request")
  })

  it("cancelled → '<other> withdrew the request' chip, no buttons", () => {
    const html = render(base({ status: "cancelled", waitingOn: null }))
    expect(html).toContain("Alice withdrew the request")
    expect(html).toContain('data-approval-status="cancelled"')
    expect(html).not.toContain(">Approve<")
    expect(html).not.toContain(">Deny<")
  })

  it("never renders any isBot marker", () => {
    const html = render(base({ status: "pending", waitingOn: "you" }))
    expect(html).not.toContain("isBot")
  })

  it("renders a stored beam avatar without treating it as an image URL", () => {
    const html = render(base({
      otherProfile: { ...OTHER, image: serializeBeamSeed("alice-face") },
    }))

    expect(html).toContain('data-testid="bot-approval-avatar"')
    expect(html).toContain("<svg")
    expect(html).not.toContain('src="avatar:beam:alice-face"')
  })

  it("renders a photo and uses the profile id when the image is absent", () => {
    const photo = render(base({
      otherProfile: { ...OTHER, image: "https://cdn.example.com/alice.png" },
    }))
    const generated = render(base({ otherProfile: OTHER }))

    expect(photo).toContain('data-avatar-kind="photo"')
    expect(generated).toContain('data-avatar-kind="beam"')
    expect(generated).toContain("<svg")
    expect(generated).not.toContain('data-slot="avatar-fallback"')
  })
})
