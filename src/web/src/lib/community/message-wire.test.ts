import { describe, expect, it } from "vitest"
import type { CommunityMessageCreate } from "@alook/shared"
import { projectCommunityMessageCreate, projectPostedMessage } from "./message-wire"

function wire(
  overrides: Partial<CommunityMessageCreate["message"]> = {},
): CommunityMessageCreate["message"] {
  return {
    id: "m1",
    seq: 42,
    authorId: "u1",
    authorName: "Gus",
    content: "hello",
    type: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  }
}

describe("projectCommunityMessageCreate", () => {
  it("preserves canonical identity and presentation fields", () => {
    const replyTo = { id: "m0", authorName: "A", text: "prior" }
    const approval = {
      friendshipId: "f1",
      status: "pending" as const,
      waitingOn: "you" as const,
      otherProfile: { id: "u2", name: "Other", discriminator: "0002", image: null },
      botProfile: { id: "b1", name: "Bot", discriminator: "0003", image: null },
    }
    const projected = projectCommunityMessageCreate(wire({
      clientNonce: "nonce",
      type: "system",
      systemKind: "thread",
      authorAvatar: "avatar",
      replyTo,
      approval,
    }))
    expect(projected).toEqual(expect.objectContaining({
      id: "m1",
      seq: 42,
      clientNonce: "nonce",
      type: "system",
      systemKind: "thread",
      authorId: "u1",
      authorName: "Gus",
      authorAvatar: "avatar",
      content: "hello",
      createdAt: "2026-08-06T00:00:00.000Z",
      replyTo,
      approval,
    }))
  })

  it("narrows embeds and maps safe image/file attachments", () => {
    const projected = projectCommunityMessageCreate(wire({
      embeds: [{ title: "Card", url: "https://example.com" }, { url: "missing-title" }, null],
      attachments: [
        { id: "a1", filename: "photo.png", url: "/photo", contentType: "image/png", size: 2048, width: 640, height: 480 },
        { id: "a2", filename: "doc.pdf", url: "/doc", contentType: "application/pdf", size: 2048 },
        { id: "a3", filename: "unsafe.svg", url: "/unsafe", contentType: "image/svg+xml", size: 1024 },
      ],
    }))
    expect(projected.embeds).toEqual([{ title: "Card", url: "https://example.com" }])
    expect(projected.attachments).toEqual([
      { kind: "image", name: "photo.png", url: "/photo", contentType: "image/png", sizeBytes: 2048, width: 640, height: 480 },
      { kind: "file", name: "doc.pdf", url: "/doc", contentType: "application/pdf", sizeBytes: 2048, size: "2.0 KB" },
      { kind: "file", name: "unsafe.svg", url: "/unsafe", contentType: "image/svg+xml", sizeBytes: 1024, size: "1.0 KB" },
    ])
  })
})

describe("projectPostedMessage", () => {
  it("falls back to an initial when the posted author has no canonical avatar", () => {
    const projected = projectPostedMessage({
      id: "m2",
      seq: 43,
      authorId: "u2",
      authorName: "Gus",
      authorImage: null,
      authorAvatarVersion: 0,
      content: "hello",
      type: "default",
      embeds: null,
      createdAt: "2026-08-06T00:00:00.000Z",
    } as never, "nonce-2")

    expect(projected).toMatchObject({
      authorAvatar: "G",
      authorAvatarVersion: 0,
      clientNonce: "nonce-2",
    })
  })
})
