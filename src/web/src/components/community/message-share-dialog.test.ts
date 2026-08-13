import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { MessageShareDialog } from "./message-share-dialog"
import type { RenderMsg } from "./_types"

vi.mock("html-to-image", () => ({ toBlob: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("next/image", () => ({ default: "img" }))
vi.mock("./avatar", () => ({ Avatar: "mock-avatar" }))
vi.mock("./message-body", () => ({ MessageBody: ({ text }: { text: string }) => text }))
vi.mock("@/components/ui/button", () => ({ Button: "button" }))
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => children
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  }
})

function message(overrides: Partial<RenderMsg> = {}): RenderMsg {
  return {
    id: "m1",
    type: "chat",
    authorId: "u1",
    authorName: "Alice",
    content: "Current message",
    grouped: false,
    ...overrides,
  }
}

function renderMessage(m: RenderMsg) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(MessageShareDialog, {
      m,
      open: true,
      onClose: vi.fn(),
    }))
  })
  return renderer!
}

describe("MessageShareDialog message context", () => {
  it("renders the reply author and plain-text excerpt above the shared message", () => {
    const renderer = renderMessage(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "A **formatted** reply",
      },
    }))

    const reply = renderer.root.findByProps({ "data-testid": "message-share-reply-m1" })
    const spans = reply.findAllByType("span")
    expect(spans.map((span) => span.children.join(""))).toEqual([
      "@Bob",
      "A formatted reply",
    ])
  })

  it("renders the deleted-original state without stale reply details", () => {
    const renderer = renderMessage(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "Stale content",
        deleted: true,
      },
    }))

    const reply = renderer.root.findByProps({ "data-testid": "message-share-reply-m1" })
    const text = reply.findAllByType("span").map((span) => span.children.join(""))
    expect(text).toEqual(["Original message was deleted"])
  })

  it("renders every emoji reaction with its count", () => {
    const renderer = renderMessage(message({
      reactions: [
        { emoji: "👍", count: 2, me: true, userIds: ["u1", "u2"] },
        { emoji: "🎉", count: 11, me: false, userIds: [] },
      ],
    }))

    const reactions = renderer.root.findByProps({ "data-testid": "message-share-reactions-m1" })
    const text = reactions.findAllByType("span").map((span) => span.children.join(""))
    expect(text).toEqual(expect.arrayContaining(["👍", "2", "🎉", "11"]))
  })

  it("does not add empty context containers", () => {
    const renderer = renderMessage(message())
    const contexts = renderer.root.findAll((node) => (
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("message-share-")
    ))
    expect(contexts).toHaveLength(0)
  })
})
