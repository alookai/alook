import type { Msg, SendAttachment } from "@/lib/community/models/message"
import type { MentionType, CommunityMessageResource } from "@alook/shared"
import { presentMessageAttachment } from "@/lib/community/attachment-presentation"

export const MAX_LIVE_MESSAGE_DELTAS = 500

export type CanonicalMessage = Msg & Pick<CommunityMessageResource, "seq"> & Partial<Pick<CommunityMessageResource, "replyToId">>

export type MessageScope =
  | { kind: "channel"; id: string; serverId: string }
  | { kind: "dm"; id: string }

type LocalUploadInput = Readonly<SendAttachment>

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
  status: "pending" | "failed"
  uploadStatus: "none" | "pending" | "settled" | "failed"
}

type MessageOverlayEffect = {
  type: "revokeObjectUrl"
  url: string
}

export type MessageOverlayIds = {
  liveIds: readonly string[]
  outboxByNonce: ReadonlyMap<string, OutboxIntent>
}

export type MessageOverlayTransition = {
  state: MessageOverlayIds
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
  | { type: "messageRemoved"; messageId: string }
  | { type: "baseChanged"; messages: CanonicalMessage[]; latestSeq?: number }
  | { type: "dismissFailed"; nonce: string }
  | { type: "clear" }

type MaterializedEntry = {
  message: Msg
  localOrdinal?: number
}

export function emptyMessageOverlay(): MessageOverlayIds {
  return {
    liveIds: [],
    outboxByNonce: new Map(),
  }
}

function unchanged(state: MessageOverlayIds): MessageOverlayTransition {
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
  state: MessageOverlayIds,
  nonce: string,
  update: (intent: OutboxIntent) => OutboxIntent,
): MessageOverlayTransition {
  const current = state.outboxByNonce.get(nonce)
  if (!current) return unchanged(state)
  const outboxByNonce = new Map(state.outboxByNonce)
  outboxByNonce.set(nonce, update(current))
  return { state: { ...state, outboxByNonce }, effects: [] }
}

function compoundIdentity(message: Pick<Msg, "authorId" | "clientNonce">): string | undefined {
  return message.authorId && message.clientNonce && !message.clientNonce.startsWith("srv:")
    ? JSON.stringify([message.authorId, message.clientNonce]) : undefined
}

function trimLiveDeltas(liveIds: Set<string>, read: (id: string) => CanonicalMessage | undefined): void {
  const overflow = liveIds.size - MAX_LIVE_MESSAGE_DELTAS
  if (overflow <= 0) return
  const oldest = [...liveIds].sort((a, b) => (read(a)?.seq ?? 0) - (read(b)?.seq ?? 0)).slice(0, overflow)
  for (const id of oldest) liveIds.delete(id)
}

function upsertLiveCanonical(liveIds: Set<string>, message: CanonicalMessage, read: (id: string) => CanonicalMessage | undefined): void {
  const identity = compoundIdentity(message)
  if (identity) for (const id of liveIds) {
    const current = read(id)
    if (id !== message.id && current && compoundIdentity(current) === identity) liveIds.delete(id)
  }
  liveIds.add(message.id)
}

export function materializeIntent(intent: OutboxIntent): Msg {
  return {
    ...intent.message,
    id: intent.tempId,
    clientNonce: intent.nonce,
    failed: intent.status === "failed" || intent.uploadStatus === "failed",
  }
}

function localUploadAttachments(
  uploads: readonly LocalUploadInput[],
): Msg["attachments"] {
  const attachments = uploads.flatMap((upload) => upload.previewObjectUrl ? [presentMessageAttachment({
    name: upload.file.name, url: upload.previewObjectUrl, contentType: upload.file.type, sizeBytes: upload.file.size,
    width: upload.width, height: upload.height,
  })] : [])
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
  overlay: MessageOverlayIds,
  canonical: Pick<ReadonlyMap<string, CanonicalMessage>, "get">,
): Msg[] {
  const byId = new Map<string, MaterializedEntry>()
  const idByIdentity = new Map<string, string>()

  for (const intent of overlay.outboxByNonce.values()) {
    upsertMaterialized(byId, idByIdentity, {
      message: materializeIntent(intent),
      localOrdinal: intent.localOrdinal,
    })
  }
  for (const id of overlay.liveIds) {
    const message = canonical.get(id)
    if (message) upsertMaterialized(byId, idByIdentity, {
      message: { ...message, failed: false },
    })
  }
  for (const message of baseMessages) {
    upsertMaterialized(byId, idByIdentity, { message })
  }

  return [...byId.values()].sort(materializedOrder).map((entry) => entry.message)
}

export function getOutboxRetryPayload(
  state: MessageOverlayIds,
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
  state: MessageOverlayIds,
  event: Exclude<MessageOverlayEvent, { type: "postAck" }>,
  canonical: Pick<ReadonlyMap<string, CanonicalMessage>, "get"> = new Map(),
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
      const liveIds = new Set(state.liveIds.filter((id) => canonical.get(id) !== undefined))
      const outboxByNonce = new Map(state.outboxByNonce)
      const effects: MessageOverlayEffect[] = []
      const eventIdentity = compoundIdentity(event.message)

      for (const [intentNonce, intent] of outboxByNonce) {
        if (intent.message.authorId !== event.message.authorId) continue
        const intentIdentity = compoundIdentity({
          authorId: intent.message.authorId,
          clientNonce: intentNonce,
        })
        if (eventIdentity === undefined || eventIdentity !== intentIdentity) continue
        outboxByNonce.delete(intentNonce)
        effects.push(...revokeEffects(intent))
      }

      const read = (id: string) => id === event.message.id ? event.message : canonical.get(id)
      upsertLiveCanonical(liveIds, event.message, read)
      trimLiveDeltas(liveIds, read)
      return { state: { liveIds: [...liveIds], outboxByNonce }, effects }
    }

    case "messageRemoved": {
      const liveIds = new Set(state.liveIds.filter((id) => canonical.get(id) !== undefined))
      let changed = liveIds.size !== state.liveIds.length
      if (liveIds.delete(event.messageId)) changed = true
      const outboxByNonce = new Map(state.outboxByNonce)
      const effects: MessageOverlayEffect[] = []
      for (const [nonce, intent] of outboxByNonce) {
        if (intent.tempId !== event.messageId) continue
        outboxByNonce.delete(nonce)
        effects.push(...revokeEffects(intent))
        changed = true
      }
      return changed
        ? { state: { liveIds: [...liveIds], outboxByNonce }, effects }
        : unchanged(state)
    }

    case "baseChanged": {
      if (!state.liveIds.length && !state.outboxByNonce.size) return unchanged(state)
      const baseById = new Map(event.messages.map((message) => [message.id, message]))
      const baseByIdentity = new Map(
        event.messages.flatMap((message) => {
          const identity = compoundIdentity(message)
          return identity ? [[identity, message] as const] : []
        }),
      )
      const liveIds = new Set(state.liveIds.filter((id) => canonical.get(id) !== undefined))
      const outboxByNonce = new Map(state.outboxByNonce)
      const effects: MessageOverlayEffect[] = []

      const read = (id: string) => baseById.get(id) ?? canonical.get(id)
      for (const id of state.liveIds) {
        const message = canonical.get(id)
        const identity = message && compoundIdentity(message)
        const replacement = baseById.get(id) ?? (identity ? baseByIdentity.get(identity) : undefined)
        if (replacement) upsertLiveCanonical(liveIds, replacement, read)
      }
      for (const [nonce, intent] of outboxByNonce) {
        const identity = compoundIdentity({
          authorId: intent.message.authorId,
          clientNonce: nonce,
        })
        const canonical = identity ? baseByIdentity.get(identity) : undefined
        if (!canonical) continue
        outboxByNonce.delete(nonce)
        upsertLiveCanonical(liveIds, canonical, read)
        effects.push(...revokeEffects(intent))
      }
      trimLiveDeltas(liveIds, read)

      // `latestSeq` is deliberately not a deletion predicate: an anchor page
      // can report a high stream seq while omitting this visible tail row. A
      // base hit refreshes the bounded fallback but does not delete it, because
      // a later window may omit the row again.
      return { state: { liveIds: [...liveIds], outboxByNonce }, effects }
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
