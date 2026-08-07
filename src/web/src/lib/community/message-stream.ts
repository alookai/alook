import type { Msg } from "@/components/community/_types"
import type { MentionType } from "@alook/shared"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"

export const MAX_LIVE_MESSAGE_DELTAS = 500

export type CanonicalMessage = Msg & { seq: number }

export type MessageScope =
  | { kind: "channel"; id: string; serverId: string }
  | { kind: "dm"; id: string }

type LocalUploadInput = Readonly<{
  file: File
  previewObjectUrl?: string
  width?: number
  height?: number
}>

type LocalOutboxMessage = Omit<Msg, "id" | "seq" | "clientNonce" | "failed">

export type NewOutboxIntent = Readonly<{
  nonce: string
  tempId: string
  localOrdinal: number
  message: LocalOutboxMessage
  localUploads: readonly LocalUploadInput[]
  mentionType?: MentionType
}>

export type OutboxRetryPayload = Readonly<{
  nonce: string
  message: Msg
  localUploads: NewOutboxIntent["localUploads"]
  uploadStatus: "none" | "pending" | "settled" | "failed"
  mentionType?: MentionType
}>

type OutboxIntent = Omit<NewOutboxIntent, "message"> & {
  message: Msg
  status: "pending" | "failed" | "acked"
  uploadStatus: "none" | "pending" | "settled" | "failed"
  serverMessageId?: string
  serverSeq?: number
}

export type MessageOverlayState = {
  liveById: ReadonlyMap<string, CanonicalMessage>
  outboxByNonce: ReadonlyMap<string, OutboxIntent>
}

type MessageOverlayEffect = {
  type: "revokeObjectUrl"
  url: string
}

export type MessageOverlayTransition = {
  state: MessageOverlayState
  effects: MessageOverlayEffect[]
}

export type MessageOverlayEvent =
  | { type: "submit"; intent: NewOutboxIntent }
  | { type: "uploadSettled"; nonce: string; attachments: Msg["attachments"] }
  | { type: "uploadFailed"; nonce: string }
  | { type: "postAck"; nonce: string; message: CanonicalMessage }
  | { type: "postFail"; nonce: string }
  | { type: "terminalReject"; nonce: string }
  | { type: "retry"; nonce: string }
  | { type: "wsMessage"; message: CanonicalMessage }
  | { type: "liveRefreshed"; message: CanonicalMessage }
  | { type: "messageEdited"; messageId: string; content: string }
  | { type: "baseChanged"; messages: CanonicalMessage[]; latestSeq?: number }
  | { type: "dismissFailed"; nonce: string }
  | { type: "clear" }

type MaterializedEntry = {
  message: Msg
  localOrdinal?: number
}

export function emptyMessageOverlay(): MessageOverlayState {
  return {
    liveById: new Map(),
    outboxByNonce: new Map(),
  }
}

function unchanged(state: MessageOverlayState): MessageOverlayTransition {
  return { state, effects: [] }
}

function revokeEffects(intent: OutboxIntent): MessageOverlayEffect[] {
  const urls = intent.localUploads.flatMap(({ previewObjectUrl }) =>
    previewObjectUrl === undefined ? [] : [previewObjectUrl])
  return [...new Set(urls)].map((url) => ({
    type: "revokeObjectUrl" as const,
    url,
  }))
}

function updateIntent(
  state: MessageOverlayState,
  nonce: string,
  update: (intent: OutboxIntent) => OutboxIntent,
): MessageOverlayTransition {
  const current = state.outboxByNonce.get(nonce)
  if (!current) return unchanged(state)
  const outboxByNonce = new Map(state.outboxByNonce)
  outboxByNonce.set(nonce, update(current))
  return { state: { ...state, outboxByNonce }, effects: [] }
}

function canonicalDeltaOrder(a: CanonicalMessage, b: CanonicalMessage): number {
  return a.seq - b.seq
}

function compoundIdentity(
  message: Pick<Msg, "authorId" | "clientNonce">,
): string | undefined {
  if (!message.authorId || !message.clientNonce || message.clientNonce.startsWith("srv:")) {
    return undefined
  }
  return JSON.stringify([message.authorId, message.clientNonce])
}

function trimLiveDeltas(liveById: Map<string, CanonicalMessage>): void {
  const overflow = liveById.size - MAX_LIVE_MESSAGE_DELTAS
  if (overflow <= 0) return
  const oldest = [...liveById.values()].sort(canonicalDeltaOrder).slice(0, overflow)
  for (const message of oldest) liveById.delete(message.id)
}

function upsertLiveCanonical(
  liveById: Map<string, CanonicalMessage>,
  message: CanonicalMessage,
): void {
  const identity = compoundIdentity(message)
  if (identity) {
    for (const [id, current] of liveById) {
      if (id !== message.id && compoundIdentity(current) === identity) liveById.delete(id)
    }
  }
  liveById.set(message.id, { ...message, failed: false })
}

function materializeIntent(intent: OutboxIntent): Msg {
  return {
    ...intent.message,
    id: intent.serverMessageId ?? intent.tempId,
    ...(intent.serverSeq !== undefined ? { seq: intent.serverSeq } : {}),
    clientNonce: intent.nonce,
    failed: intent.status === "failed" || intent.uploadStatus === "failed",
  }
}

function localUploadAttachments(
  uploads: readonly LocalUploadInput[],
): Msg["attachments"] {
  const attachments: NonNullable<Msg["attachments"]> = []
  for (const upload of uploads) {
    if (!upload.previewObjectUrl) continue
    if (isInlineAttachmentContentType(upload.file.type)) {
      attachments.push({
        kind: "image",
        name: upload.file.name,
        url: upload.previewObjectUrl,
        width: upload.width,
        height: upload.height,
      })
      continue
    }
    attachments.push({
      kind: "file",
      name: upload.file.name,
      url: upload.previewObjectUrl,
      size: upload.file.size ? `${Math.round(upload.file.size / 1024)} KB` : "",
    })
  }
  return attachments.length > 0 ? attachments : undefined
}

function upsertMaterialized(
  byId: Map<string, MaterializedEntry>,
  idByIdentity: Map<string, string>,
  entry: MaterializedEntry,
): void {
  const { message } = entry
  const identity = compoundIdentity(message)
  if (identity) {
    const priorId = idByIdentity.get(identity)
    if (priorId && priorId !== message.id) byId.delete(priorId)
    idByIdentity.set(identity, message.id)
  }
  byId.set(message.id, entry)
}

function materializedOrder(a: MaterializedEntry, b: MaterializedEntry): number {
  const aSeq = a.message.seq
  const bSeq = b.message.seq
  if (aSeq !== undefined && bSeq !== undefined && aSeq !== bSeq) return aSeq - bSeq
  if (aSeq !== undefined && bSeq === undefined) return -1
  if (aSeq === undefined && bSeq !== undefined) return 1

  const aOrdinal = a.localOrdinal
  const bOrdinal = b.localOrdinal
  if (aOrdinal !== undefined && bOrdinal !== undefined && aOrdinal !== bOrdinal) {
    return aOrdinal - bOrdinal
  }
  if (aOrdinal !== undefined && bOrdinal === undefined) return 1
  if (aOrdinal === undefined && bOrdinal !== undefined) return -1

  return 0
}

export function materializeMessageStream(
  baseMessages: CanonicalMessage[],
  overlay: MessageOverlayState,
): Msg[] {
  const byId = new Map<string, MaterializedEntry>()
  const idByIdentity = new Map<string, string>()

  // Later sources replace earlier presentation for the same id/nonce:
  // optimistic outbox < complete WS row < complete base row.
  for (const intent of overlay.outboxByNonce.values()) {
    upsertMaterialized(byId, idByIdentity, {
      message: materializeIntent(intent),
      localOrdinal: intent.status === "acked" ? undefined : intent.localOrdinal,
    })
  }
  for (const message of overlay.liveById.values()) {
    upsertMaterialized(byId, idByIdentity, { message })
  }
  for (const message of baseMessages) {
    upsertMaterialized(byId, idByIdentity, { message })
  }

  return [...byId.values()].sort(materializedOrder).map((entry) => entry.message)
}

export function getOutboxRetryPayload(
  state: MessageOverlayState,
  nonce: string,
): OutboxRetryPayload | undefined {
  const intent = state.outboxByNonce.get(nonce)
  if (!intent) return undefined
  return {
    nonce,
    message: intent.message,
    localUploads: intent.localUploads,
    uploadStatus: intent.uploadStatus,
    mentionType: intent.mentionType,
  }
}

export function reduceMessageOverlay(
  state: MessageOverlayState,
  event: MessageOverlayEvent,
): MessageOverlayTransition {
  switch (event.type) {
    case "submit": {
      if (state.outboxByNonce.has(event.intent.nonce)) return unchanged(state)
      const outboxByNonce = new Map(state.outboxByNonce)
      const optimisticAttachments = localUploadAttachments(event.intent.localUploads)
      const message: Msg = {
        ...event.intent.message,
        id: event.intent.tempId,
        clientNonce: event.intent.nonce,
        failed: false,
        ...(optimisticAttachments !== undefined
          ? { attachments: optimisticAttachments }
          : {}),
      }
      delete message.seq
      outboxByNonce.set(event.intent.nonce, {
        nonce: event.intent.nonce,
        tempId: event.intent.tempId,
        localOrdinal: event.intent.localOrdinal,
        localUploads: event.intent.localUploads.map((upload) => ({ ...upload })),
        status: "pending",
        uploadStatus: event.intent.localUploads.length === 0 ? "none" : "pending",
        message,
        mentionType: event.intent.mentionType,
      })
      return { state: { ...state, outboxByNonce }, effects: [] }
    }

    case "uploadSettled":
      return updateIntent(state, event.nonce, (intent) => ({
        ...intent,
        uploadStatus: "settled",
        message: { ...intent.message, attachments: event.attachments },
      }))

    case "uploadFailed":
      return updateIntent(state, event.nonce, (intent) => ({
        ...intent,
        status: "failed",
        uploadStatus: "failed",
        message: { ...intent.message, failed: true },
      }))

    case "postAck": {
      const intent = state.outboxByNonce.get(event.nonce)
      if (!intent) return unchanged(state)
      const outboxByNonce = new Map(state.outboxByNonce)
      const canonical = event.message
      outboxByNonce.set(event.nonce, {
        ...intent,
        status: "acked",
        serverMessageId: canonical.id,
        serverSeq: canonical.seq,
        localUploads: [],
        message: {
          ...intent.message,
          ...canonical,
          clientNonce: event.nonce,
          replyTo: canonical.replyTo ?? intent.message.replyTo,
          attachments: canonical.attachments ?? intent.message.attachments,
          failed: false,
        },
      })
      return {
        state: { ...state, outboxByNonce },
        effects: revokeEffects(intent),
      }
    }

    case "postFail":
      return updateIntent(state, event.nonce, (intent) => ({
        ...intent,
        status: "failed",
        message: { ...intent.message, failed: true },
      }))

    case "terminalReject": {
      const intent = state.outboxByNonce.get(event.nonce)
      if (!intent) return unchanged(state)
      const outboxByNonce = new Map(state.outboxByNonce)
      outboxByNonce.delete(event.nonce)
      return {
        state: { ...state, outboxByNonce },
        effects: revokeEffects(intent),
      }
    }

    case "retry":
      return updateIntent(state, event.nonce, (intent) => ({
        ...intent,
        status: "pending",
        uploadStatus: intent.uploadStatus === "failed" ? "pending" : intent.uploadStatus,
        message: { ...intent.message, failed: false },
      }))

    case "wsMessage": {
      const liveById = new Map(state.liveById)
      const outboxByNonce = new Map(state.outboxByNonce)
      const effects: MessageOverlayEffect[] = []
      const eventIdentity = compoundIdentity(event.message)

      for (const [intentNonce, intent] of outboxByNonce) {
        if (intent.message.authorId !== event.message.authorId) continue
        const intentIdentity = compoundIdentity({
          authorId: intent.message.authorId,
          clientNonce: intentNonce,
        })
        const matchesIdentity = eventIdentity !== undefined && eventIdentity === intentIdentity
        const matchesServerId = intent.serverMessageId === event.message.id
        if (!matchesIdentity && !matchesServerId) continue
        outboxByNonce.delete(intentNonce)
        effects.push(...revokeEffects(intent))
      }

      // The complete enriched WS row is canonical presentation.
      upsertLiveCanonical(liveById, event.message)
      trimLiveDeltas(liveById)
      return { state: { liveById, outboxByNonce }, effects }
    }

    case "liveRefreshed": {
      let existingId: string | undefined
      if (state.liveById.has(event.message.id)) {
        existingId = event.message.id
      } else {
        const identity = compoundIdentity(event.message)
        for (const [id, message] of state.liveById) {
          if (identity && compoundIdentity(message) === identity) {
            existingId = id
            break
          }
        }
      }
      if (!existingId) return unchanged(state)
      const liveById = new Map(state.liveById)
      if (existingId !== event.message.id) liveById.delete(existingId)
      upsertLiveCanonical(liveById, event.message)
      trimLiveDeltas(liveById)
      return { state: { ...state, liveById }, effects: [] }
    }

    case "messageEdited": {
      let changed = false
      const liveById = new Map(state.liveById)
      const live = liveById.get(event.messageId)
      if (live) {
        liveById.set(event.messageId, { ...live, content: event.content })
        changed = true
      }
      const outboxByNonce = new Map(state.outboxByNonce)
      for (const [nonce, intent] of outboxByNonce) {
        if ((intent.serverMessageId ?? intent.tempId) !== event.messageId) continue
        outboxByNonce.set(nonce, {
          ...intent,
          message: { ...intent.message, content: event.content },
        })
        changed = true
      }
      return changed
        ? { state: { ...state, liveById, outboxByNonce }, effects: [] }
        : unchanged(state)
    }

    case "baseChanged": {
      const baseById = new Map(event.messages.map((message) => [message.id, message]))
      const baseByIdentity = new Map(
        event.messages.flatMap((message) => {
          const identity = compoundIdentity(message)
          return identity ? [[identity, message] as const] : []
        }),
      )
      const liveById = new Map(state.liveById)
      const outboxByNonce = new Map(state.outboxByNonce)
      const effects: MessageOverlayEffect[] = []

      for (const message of state.liveById.values()) {
        const identity = compoundIdentity(message)
        const canonical = baseById.get(message.id)
          ?? (identity ? baseByIdentity.get(identity) : undefined)
        if (canonical) upsertLiveCanonical(liveById, canonical)
      }
      for (const [nonce, intent] of outboxByNonce) {
        const canonicalById = intent.serverMessageId
          ? baseById.get(intent.serverMessageId)
          : undefined
        const identity = compoundIdentity({
          authorId: intent.message.authorId,
          clientNonce: nonce,
        })
        const canonical = canonicalById?.authorId === intent.message.authorId
          ? canonicalById
          : identity
            ? baseByIdentity.get(identity)
            : undefined
        if (!canonical) continue
        outboxByNonce.delete(nonce)
        upsertLiveCanonical(liveById, canonical)
        effects.push(...revokeEffects(intent))
      }
      trimLiveDeltas(liveById)

      // `latestSeq` is deliberately not a deletion predicate: an anchor page
      // can report a high stream seq while omitting this visible tail row. A
      // base hit refreshes the bounded fallback but does not delete it, because
      // a later window may omit the row again.
      return { state: { liveById, outboxByNonce }, effects }
    }

    case "dismissFailed": {
      const intent = state.outboxByNonce.get(event.nonce)
      if (!intent || (intent.status !== "failed" && intent.uploadStatus !== "failed")) {
        return unchanged(state)
      }
      const outboxByNonce = new Map(state.outboxByNonce)
      outboxByNonce.delete(event.nonce)
      return {
        state: { ...state, outboxByNonce },
        effects: revokeEffects(intent),
      }
    }

    case "clear": {
      const effects = [...state.outboxByNonce.values()].flatMap(revokeEffects)
      return { state: emptyMessageOverlay(), effects }
    }
  }
}
