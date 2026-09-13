import { describe, expect, it } from "vitest"
import { parseQueueTask, parseQueueTaskBatch } from "../../src/community/queue-task"

describe("parseQueueTask", () => {
  it.each([
    {
      name: "legacy",
      value: { messageId: "message-1", botUserId: "bot-1" },
      source: "legacy",
    },
    {
      name: "v1 bot-wake",
      value: { version: 1, kind: "bot-wake", messageId: "message-1", botUserId: "bot-1" },
      source: "v1",
    },
  ])("normalizes a valid $name task", ({ value, source }) => {
    expect(parseQueueTask(value)).toEqual({
      ok: true,
      source,
      task: {
        version: 1,
        kind: "bot-wake",
        messageId: "message-1",
        botUserId: "bot-1",
      },
    })
  })

  it.each([
    { name: "null", value: null },
    { name: "array", value: [] },
    { name: "primitive", value: "wake" },
    { name: "missing legacy key", value: { messageId: "message-1" } },
    { name: "extra legacy key", value: { messageId: "message-1", botUserId: "bot-1", extra: true } },
    { name: "empty message ID", value: { messageId: "", botUserId: "bot-1" } },
    { name: "blank bot ID", value: { messageId: "message-1", botUserId: "   " } },
    { name: "missing version", value: { kind: "bot-wake", messageId: "message-1", botUserId: "bot-1" } },
    { name: "non-number version", value: { version: "1", kind: "bot-wake", messageId: "message-1", botUserId: "bot-1" } },
    { name: "missing kind", value: { version: 1, messageId: "message-1", botUserId: "bot-1" } },
    { name: "extra v1 key", value: { version: 1, kind: "bot-wake", messageId: "message-1", botUserId: "bot-1", extra: true } },
    { name: "wrong v1 recipient key", value: { version: 1, kind: "bot-wake", messageId: "message-1", userId: "bot-1" } },
    { name: "malformed mobile-push", value: { version: 1, kind: "mobile-push", messageId: "message-1", userId: "" } },
  ])("rejects malformed input: $name", ({ value }) => {
    expect(parseQueueTask(value)).toEqual({ ok: false, reason: "malformed" })
  })

  it("classifies unsupported versions", () => {
    expect(parseQueueTask({
      version: 2,
      kind: "bot-wake",
      messageId: "message-1",
      botUserId: "bot-1",
    })).toEqual({ ok: false, reason: "unsupported_version" })
  })

  it("classifies unknown v1 task kinds", () => {
    expect(parseQueueTask({
      version: 1,
      kind: "email",
      messageId: "message-1",
      userId: "user-1",
    })).toEqual({ ok: false, reason: "unknown_kind" })
  })

  it("accepts an exact mobile-push task", () => {
    expect(parseQueueTask({
      version: 1,
      kind: "mobile-push",
      messageId: "message-1",
      userId: "user-1",
    })).toEqual({
      ok: true,
      source: "v1",
      task: {
        version: 1,
        kind: "mobile-push",
        messageId: "message-1",
        userId: "user-1",
      },
    })
  })
})

describe("parseQueueTaskBatch", () => {
  it("normalizes the complete legacy/v1 batch", () => {
    expect(parseQueueTaskBatch([
      { messageId: "message-1", botUserId: "bot-1" },
      { version: 1, kind: "bot-wake", messageId: "message-2", botUserId: "bot-2" },
      { version: 1, kind: "mobile-push", messageId: "message-3", userId: "user-3" },
    ])).toEqual({
      ok: true,
      tasks: [
        { version: 1, kind: "bot-wake", messageId: "message-1", botUserId: "bot-1" },
        { version: 1, kind: "bot-wake", messageId: "message-2", botUserId: "bot-2" },
        { version: 1, kind: "mobile-push", messageId: "message-3", userId: "user-3" },
      ],
    })
  })

  it("reports the first rejected item without returning partial payloads", () => {
    expect(parseQueueTaskBatch([
      { messageId: "message-1", botUserId: "bot-1" },
      { version: 1, kind: "email", messageId: "message-2", userId: "user-2" },
      { messageId: "message-3", botUserId: "bot-3" },
    ])).toEqual({ ok: false, reason: "unknown_kind", itemIndex: 1 })
  })

  it("rejects a non-array body", () => {
    expect(parseQueueTaskBatch({ messageId: "message-1", botUserId: "bot-1" }))
      .toEqual({ ok: false, reason: "malformed", itemIndex: null })
  })
})
