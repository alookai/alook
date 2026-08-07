import { describe, expect, it } from "vitest"
import type { Msg } from "@/components/community/_types"
import {
  MAX_LIVE_MESSAGE_DELTAS,
  emptyMessageOverlay,
  getOutboxRetryPayload,
  materializeMessageStream,
  reduceMessageOverlay,
  type CanonicalMessage,
  type MessageOverlayEvent,
  type MessageOverlayState,
  type NewOutboxIntent,
} from "./message-stream"

function message(id: string, seq: number, extra: Partial<Msg> = {}): CanonicalMessage {
  return {
    id,
    seq,
    type: "chat",
    authorId: "u1",
    authorName: "Gus",
    content: id,
    createdAt: `2026-08-06T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...extra,
  }
}

function localMessage(content: string): NewOutboxIntent["message"] {
  return {
    type: "chat",
    authorId: "u1",
    authorName: "Gus",
    content,
    createdAt: "2026-08-06T00:00:00.000Z",
  }
}

function intent(
  nonce: string,
  localOrdinal: number,
  extra: Partial<NewOutboxIntent> = {},
): NewOutboxIntent {
  const tempId = `temp_${nonce}`
  return {
    nonce,
    tempId,
    localOrdinal,
    message: localMessage(nonce),
    localUploads: [],
    ...extra,
  }
}

function apply(state: MessageOverlayState, event: MessageOverlayEvent) {
  return reduceMessageOverlay(state, event)
}

function ids(base: CanonicalMessage[], state: MessageOverlayState): string[] {
  return materializeMessageStream(base, state).map((row) => row.id)
}

function submit(state: MessageOverlayState, value = intent("n1", 1)) {
  return apply(state, { type: "submit", intent: value }).state
}

function canonical(
  id = "m1",
  seq = 11,
  nonce = "n1",
  extra: Partial<Msg> = {},
): CanonicalMessage {
  return message(id, seq, { clientNonce: nonce, authorName: "Canonical", ...extra })
}

function ack(nonce = "n1", id = "m1", seq = 11, extra: Partial<Msg> = {}): MessageOverlayEvent {
  return { type: "postAck", nonce, message: canonical(id, seq, nonce, extra) }
}

describe("message stream monotonic visibility", () => {
  it("keeps a pending row when an anchor snapshot started first and resolves without it", () => {
    let state = submit(emptyMessageOverlay())
    state = apply(state, {
      type: "baseChanged",
      messages: [message("anchor", 5)],
      latestSeq: 99,
    }).state

    expect(ids([message("anchor", 5)], state)).toEqual(["anchor", "temp_n1"])
  })

  it.each([
    ["ack → WS → stale snapshot", [
      ack(),
      { type: "wsMessage", message: canonical() },
      { type: "baseChanged", messages: [message("older", 5)], latestSeq: 10 },
    ]],
    ["WS → ack → stale snapshot", [
      { type: "wsMessage", message: canonical() },
      ack(),
      { type: "baseChanged", messages: [message("older", 5)], latestSeq: 10 },
    ]],
    ["stale snapshot → ack → delayed WS", [
      { type: "baseChanged", messages: [message("older", 5)], latestSeq: 10 },
      ack(),
      { type: "wsMessage", message: canonical() },
    ]],
    ["WS → stale snapshot → ack", [
      { type: "wsMessage", message: canonical() },
      { type: "baseChanged", messages: [message("older", 5)], latestSeq: 10 },
      ack(),
    ]],
  ] satisfies Array<[string, MessageOverlayEvent[]]>) (
    "%s always materializes exactly one canonical row",
    (_label, events) => {
      let state = submit(emptyMessageOverlay())
      for (const event of events) state = apply(state, event).state
      expect(ids([message("older", 5)], state)).toEqual(["older", "m1"])
      expect(materializeMessageStream([message("older", 5)], state)[1].authorName).toBe("Canonical")
    },
  )

  it("replaying a first-seen WS event after a snapshot overwrite attempt is idempotent", () => {
    const row = canonical()
    let state = apply(emptyMessageOverlay(), { type: "wsMessage", message: row }).state
    state = apply(state, { type: "baseChanged", messages: [], latestSeq: 12 }).state
    state = apply(state, { type: "wsMessage", message: row }).state

    expect(ids([], state)).toEqual(["m1"])
    expect(state.liveById.size).toBe(1)
  })

  it("materializes an outbox row synchronously when base/pages are absent", () => {
    const state = submit(emptyMessageOverlay())
    expect(ids([], state)).toEqual(["temp_n1"])
  })

  it("initializes submit state without accepting caller-supplied server identity", () => {
    const injected = {
      ...intent("n1", 1),
      status: "acked",
      uploadStatus: "settled",
      serverMessageId: "injected",
      serverSeq: 999,
      message: { ...localMessage("n1"), id: "injected", seq: 999, clientNonce: "other" },
    } as unknown as NewOutboxIntent

    const state = submit(emptyMessageOverlay(), injected)
    const stored = state.outboxByNonce.get("n1")
    expect(stored).toEqual(expect.objectContaining({
      status: "pending",
      uploadStatus: "none",
    }))
    expect(stored?.serverMessageId).toBeUndefined()
    expect(stored?.serverSeq).toBeUndefined()
    const materialized = materializeMessageStream([], state)[0]
    expect(materialized).toEqual(expect.objectContaining({
      id: "temp_n1",
      clientNonce: "n1",
    }))
    expect(materialized.seq).toBeUndefined()
  })

  it("retains mentionType in the retry payload", () => {
    let state = submit(emptyMessageOverlay(), intent("n1", 1, { mentionType: "everyone" }))
    expect(getOutboxRetryPayload(state, "n1")?.mentionType).toBe("everyone")
    state = apply(state, { type: "postFail", nonce: "n1" }).state
    state = apply(state, { type: "retry", nonce: "n1" }).state
    expect(getOutboxRetryPayload(state, "n1")?.mentionType).toBe("everyone")
  })

  it("failed retry reuses one nonce and converges through deduped ack + WS", () => {
    let state = submit(emptyMessageOverlay())
    state = apply(state, { type: "postFail", nonce: "n1" }).state
    expect(materializeMessageStream([], state)[0].failed).toBe(true)

    state = apply(state, { type: "retry", nonce: "n1" }).state
    expect(state.outboxByNonce.size).toBe(1)
    expect(state.outboxByNonce.get("n1")?.status).toBe("pending")

    state = apply(state, ack()).state
    state = apply(state, { type: "wsMessage", message: canonical() }).state
    expect(ids([], state)).toEqual(["m1"])
    expect(state.outboxByNonce.size).toBe(0)
  })

  it("merges the full POST canonical row into the intent while retaining optimistic reply and attachments", () => {
    const replyTo = { id: "reply_1", authorName: "Reply Author", text: "preview" }
    const attachments: Msg["attachments"] = [{ kind: "image", name: "image.png", url: "/local/image" }]
    let state = submit(emptyMessageOverlay(), intent("n1", 1, {
      message: { ...localMessage("optimistic"), replyTo, attachments },
    }))

    state = apply(state, ack("n1", "m1", 11, {
      authorName: "Canonical Author",
      authorAvatar: "canonical-avatar",
      content: "canonical content",
      createdAt: "2026-08-07T10:00:00.000Z",
      embeds: [{ title: "Canonical embed" }],
    })).state

    expect(materializeMessageStream([], state)).toEqual([
      expect.objectContaining({
        id: "m1",
        seq: 11,
        authorName: "Canonical Author",
        authorAvatar: "canonical-avatar",
        content: "canonical content",
        createdAt: "2026-08-07T10:00:00.000Z",
        embeds: [{ title: "Canonical embed" }],
        replyTo,
        attachments,
        clientNonce: "n1",
        failed: false,
      }),
    ])
  })

  it("does not treat latestSeq as proof that an anchor window contains the row", () => {
    let state = submit(emptyMessageOverlay())
    state = apply(state, ack()).state
    state = apply(state, {
      type: "baseChanged",
      messages: [message("anchor", 50)],
      latestSeq: 100,
    }).state

    expect(ids([message("anchor", 50)], state)).toEqual(["m1", "anchor"])
    expect(state.outboxByNonce.has("n1")).toBe(true)
  })

  it("settles an exact base hit into a bounded fallback that survives later window omission", () => {
    let state = submit(emptyMessageOverlay())
    state = apply(state, ack()).state
    state = apply(state, {
      type: "baseChanged",
      messages: [canonical("m1", 11, "n1", { content: "from base" })],
    }).state

    expect(state.outboxByNonce.size).toBe(0)
    expect(state.liveById.get("m1")?.content).toBe("from base")
    expect(ids([canonical()], state)).toEqual(["m1"])

    state = apply(state, {
      type: "baseChanged",
      messages: [message("older", 5)],
      latestSeq: 50,
    }).state
    expect(ids([message("older", 5)], state)).toEqual(["older", "m1"])
    expect(materializeMessageStream([message("older", 5)], state)[1].content).toBe("from base")
  })

  it("keeps a realtime row as fallback after base contains it and later omits it", () => {
    let state = apply(emptyMessageOverlay(), {
      type: "wsMessage",
      message: canonical("m1", 11, "n1", { content: "from ws" }),
    }).state
    state = apply(state, {
      type: "baseChanged",
      messages: [canonical("m1", 11, "n1", { content: "from base" })],
    }).state
    state = apply(state, { type: "baseChanged", messages: [], latestSeq: 50 }).state

    expect(materializeMessageStream([], state)).toEqual([
      expect.objectContaining({ id: "m1", seq: 11, content: "from base" }),
    ])
  })

  it("uses complete WS presentation for a same-nonce optimistic intent", () => {
    let state = submit(emptyMessageOverlay())
    state = apply(state, {
      type: "wsMessage",
      message: canonical("m1", 11, "n1", { content: "enriched", authorAvatar: "avatar" }),
    }).state

    expect(materializeMessageStream([], state)).toEqual([
      expect.objectContaining({ id: "m1", content: "enriched", authorAvatar: "avatar", failed: false }),
    ])
  })

  it("sorts canonical rows by seq and pending rows by explicit localOrdinal", () => {
    let state = submit(emptyMessageOverlay(), intent("n2", 2))
    state = submit(state, intent("n1", 1))

    expect(ids([message("m20", 20), message("m10", 10)], state)).toEqual([
      "m10", "m20", "temp_n1", "temp_n2",
    ])

    state = apply(state, ack("n2", "m15", 15)).state
    expect(ids([message("m20", 20), message("m10", 10)], state)).toEqual([
      "m10", "m15", "m20", "temp_n1",
    ])
  })

  it("refreshes only an existing live fallback and never absorbs outbox", () => {
    const initial = emptyMessageOverlay()
    const absent = apply(initial, {
      type: "liveRefreshed",
      message: canonical("m1", 11, "n1", { content: "ignored" }),
    })
    expect(absent.state).toBe(initial)
    expect(absent.state.liveById.size).toBe(0)

    let state = submit(emptyMessageOverlay())
    state = apply(state, { type: "wsMessage", message: canonical() }).state
    state = submit(state, intent("n2", 2))
    state = apply(state, {
      type: "liveRefreshed",
      message: canonical("m1", 11, "n1", { content: "refreshed" }),
    }).state
    expect(state.liveById.get("m1")?.content).toBe("refreshed")
    expect(state.outboxByNonce.has("n2")).toBe(true)
  })

  it("patches edited content across live and acknowledged outbox rows", () => {
    let state = submit(emptyMessageOverlay(), intent("n1", 1))
    state = apply(state, ack()).state
    state = apply(state, {
      type: "wsMessage",
      message: canonical("m2", 12, "n2", { content: "before" }),
    }).state

    state = apply(state, { type: "messageEdited", messageId: "m1", content: "outbox edit" }).state
    state = apply(state, { type: "messageEdited", messageId: "m2", content: "live edit" }).state

    expect(state.outboxByNonce.get("n1")?.message.content).toBe("outbox edit")
    expect(state.liveById.get("m2")?.content).toBe("live edit")
  })

  it("bounds canonical live deltas to the existing 500-row live-tail scale", () => {
    let state = emptyMessageOverlay()
    for (let seq = 1; seq <= MAX_LIVE_MESSAGE_DELTAS + 2; seq++) {
      state = apply(state, { type: "wsMessage", message: message(`m${seq}`, seq) }).state
    }

    expect(state.liveById.size).toBe(MAX_LIVE_MESSAGE_DELTAS)
    expect(state.liveById.has("m1")).toBe(false)
    expect(state.liveById.has("m2")).toBe(false)
    expect(state.liveById.has(`m${MAX_LIVE_MESSAGE_DELTAS + 2}`)).toBe(true)
  })
})

describe("attachment ownership effects", () => {
  const retryFile = { name: "notes.txt", size: 1024, type: "text/plain" } as File
  const attachedIntent = () => intent("files", 1, {
    localUploads: [
      { file: retryFile, previewObjectUrl: "blob:a", width: 640, height: 480 },
      { file: { name: "photo.png", size: 2048, type: "image/png" } as File, previewObjectUrl: "blob:b", width: 320, height: 240 },
      { file: { name: "copy.txt", size: 1024, type: "text/plain" } as File, previewObjectUrl: "blob:a" },
    ],
  })

  it("initializes lifecycle and retains immutable upload inputs through retry", () => {
    let state = submit(emptyMessageOverlay(), attachedIntent())
    expect(state.outboxByNonce.get("files")).toEqual(expect.objectContaining({
      status: "pending",
      uploadStatus: "pending",
    }))

    state = apply(state, { type: "uploadFailed", nonce: "files" }).state
    state = apply(state, { type: "retry", nonce: "files" }).state

    const retried = state.outboxByNonce.get("files")
    expect(retried?.localUploads[0].file).toBe(retryFile)
    expect(retried?.localUploads[0].previewObjectUrl).toBe("blob:a")
    expect(retried?.localUploads[0].width).toBe(640)
    expect(retried?.localUploads[0].height).toBe(480)
    expect(retried?.uploadStatus).toBe("pending")
    expect(materializeMessageStream([], state)[0].attachments).toEqual([
      { kind: "file", name: "notes.txt", url: "blob:a", size: "1 KB" },
      { kind: "image", name: "photo.png", url: "blob:b", width: 320, height: 240 },
      { kind: "file", name: "copy.txt", url: "blob:a", size: "1 KB" },
    ])
  })

  it("transfers attachment preview ownership on ack and never revokes twice on WS/base/clear", () => {
    let state = submit(emptyMessageOverlay(), attachedIntent())
    state = apply(state, {
      type: "uploadSettled",
      nonce: "files",
      attachments: [{ kind: "file", name: "notes.txt", url: "/media/notes", size: "1 KB" }],
    }).state
    const acked = apply(state, ack("files", "mf", 20))
    expect(acked.effects).toEqual([
      { type: "revokeObjectUrl", url: "blob:a" },
      { type: "revokeObjectUrl", url: "blob:b" },
    ])
    expect(acked.state.outboxByNonce.get("files")?.localUploads).toEqual([])
    expect(acked.state.outboxByNonce.get("files")?.message.attachments).toEqual([
      { kind: "file", name: "notes.txt", url: "/media/notes", size: "1 KB" },
    ])

    const ws = apply(acked.state, { type: "wsMessage", message: canonical("mf", 20, "files") })
    expect(ws.effects).toEqual([])
    expect(ws.state.outboxByNonce.size).toBe(0)
    const base = apply(ws.state, { type: "baseChanged", messages: [canonical("mf", 20, "files")] })
    expect(base.effects).toEqual([])
    const cleared = apply(base.state, { type: "clear" })
    expect(cleared.effects).toEqual([])

    const replay = apply(cleared.state, { type: "wsMessage", message: canonical("mf", 20, "files") })
    expect(replay.effects).toEqual([])
    expect(ids([], replay.state)).toEqual(["mf"])
  })

  it("revokes once when WS wins before ack, while postFail keeps previews owned", () => {
    const submitted = submit(emptyMessageOverlay(), attachedIntent())
    const failed = apply(submitted, { type: "postFail", nonce: "files" })
    expect(failed.effects).toEqual([])
    expect(failed.state.outboxByNonce.get("files")?.localUploads).toHaveLength(3)

    const ws = apply(submitted, { type: "wsMessage", message: canonical("mf", 20, "files") })
    expect(ws.effects).toEqual([
      { type: "revokeObjectUrl", url: "blob:a" },
      { type: "revokeObjectUrl", url: "blob:b" },
    ])
    const lateAck = apply(ws.state, ack("files", "mf", 20))
    expect(lateAck.effects).toEqual([])
  })

  it("retains upload failure across retry and only dismisses explicitly", () => {
    let state = submit(emptyMessageOverlay(), attachedIntent())
    state = apply(state, { type: "uploadFailed", nonce: "files" }).state
    expect(state.outboxByNonce.get("files")).toEqual(expect.objectContaining({
      status: "failed",
      uploadStatus: "failed",
    }))

    state = apply(state, { type: "retry", nonce: "files" }).state
    expect(state.outboxByNonce.get("files")).toEqual(expect.objectContaining({
      status: "pending",
      uploadStatus: "pending",
    }))

    state = apply(state, { type: "uploadFailed", nonce: "files" }).state
    const dismissed = apply(state, { type: "dismissFailed", nonce: "files" })
    expect(dismissed.effects).toHaveLength(2)
    expect(dismissed.state.outboxByNonce.size).toBe(0)
  })

  it("terminally rejects a confirmed non-commit and revokes owned URLs once", () => {
    const state = submit(emptyMessageOverlay(), attachedIntent())
    const rejected = apply(state, { type: "terminalReject", nonce: "files" })

    expect(rejected.state.outboxByNonce.size).toBe(0)
    expect(rejected.effects).toEqual([
      { type: "revokeObjectUrl", url: "blob:a" },
      { type: "revokeObjectUrl", url: "blob:b" },
    ])
    expect(apply(rejected.state, { type: "terminalReject", nonce: "files" }).effects).toEqual([])
  })

  it("emits cleanup exactly once for canonical base absorption and clear", () => {
    const state = submit(emptyMessageOverlay(), attachedIntent())
    const acked = apply(state, ack("files", "mf", 20))
    expect(acked.effects).toHaveLength(2)
    const absorbed = apply(acked.state, { type: "baseChanged", messages: [canonical("mf", 20, "files")] })
    expect(absorbed.effects).toEqual([])

    const absorbedAgain = apply(absorbed.state, { type: "baseChanged", messages: [canonical("mf", 20, "files")] })
    expect(absorbedAgain.effects).toEqual([])

    const withSecond = submit(absorbedAgain.state, intent("second", 2, {
      localUploads: [{ file: { name: "second.txt" } as File, previewObjectUrl: "blob:c" }],
    }))
    const cleared = apply(withSecond, { type: "clear" })
    expect(cleared.effects).toEqual([{ type: "revokeObjectUrl", url: "blob:c" }])
    expect(cleared.state).toEqual(emptyMessageOverlay())
  })
})
