import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Message } from "./message"
import { MessageRow } from "./message-row"

vi.mock("./message", () => ({ Message: vi.fn(() => null) }))

const mockedMessage = vi.mocked(Message)

describe("MessageRow", () => {
  beforeEach(() => vi.clearAllMocks())

  it("binds reply to the exact row id and passes canonical mention text unchanged", () => {
    const onReplyId = vi.fn()
    const onInsertMentionText = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MessageRow, {
        m: {
          id: "message_42",
          type: "chat",
          authorId: "user_7",
          authorName: "Alice",
          content: "hello",
          grouped: false,
        },
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onReplyId,
        mentionText: "@Alice#1234 ",
        onInsertMentionText,
      }))
    })

    const messageProps = mockedMessage.mock.calls.at(-1)![0]
    act(() => messageProps.onReply?.())
    act(() => messageProps.onMentionAuthor?.())
    expect(onReplyId).toHaveBeenCalledOnce()
    expect(onReplyId).toHaveBeenCalledWith("message_42")
    expect(onInsertMentionText).toHaveBeenCalledOnce()
    expect(onInsertMentionText).toHaveBeenCalledWith("@Alice#1234 ")

    act(() => renderer.unmount())
  })

  it("does not expose mention behavior without both text and an insertion seam", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MessageRow, {
        m: { id: "m1", type: "chat", grouped: false },
        hoverCapable: false,
        onOpenThread: vi.fn(),
        mentionText: "@Alice#1234 ",
      }))
    })
    expect(mockedMessage.mock.calls.at(-1)![0].onMentionAuthor).toBeUndefined()
    act(() => renderer.unmount())
  })
})
