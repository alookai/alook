import type { BrowserContext, WebSocketRoute } from "@playwright/test"

export type CapturedCommunityFrame = {
  type: string
  contractVersion?: number
  operationId?: string
  operationDigest?: string
  events?: CapturedCommunityFrame[]
  channelId?: string
  parentChannelId?: string
  messageId?: string
  message?: { id?: string; seq?: number; content?: string }
  [key: string]: unknown
}

type FrameDecision = (
  frame: CapturedCommunityFrame,
) => "drop" | "duplicate" | "forward" | "hold"

type HeldCommunityFrame = {
  client: WebSocketRoute
  frame: CapturedCommunityFrame
  message: string | Buffer
}

export type CommunityWsProxy = {
  frames: CapturedCommunityFrame[]
  heldCount: () => number
  releaseHeld: (predicate?: (frame: CapturedCommunityFrame) => boolean) => number
  replay: (frame: CapturedCommunityFrame) => void
}

export type CommunityWsProxyOptions = {
  decide?: FrameDecision
  stripCommunityBatchCapability?: boolean
}

function parseCommunityFrame(message: string | Buffer): CapturedCommunityFrame | null {
  try {
    const value = JSON.parse(message.toString()) as unknown
    if (
      typeof value !== "object"
      || value === null
      || !("type" in value)
      || typeof value.type !== "string"
      || !value.type.startsWith("community:")
    ) return null
    return value as CapturedCommunityFrame
  } catch {
    return null
  }
}

export async function proxyCommunityWebSockets(
  context: BrowserContext,
  options: CommunityWsProxyOptions = {},
): Promise<CommunityWsProxy> {
  const frames: CapturedCommunityFrame[] = []
  const held: HeldCommunityFrame[] = []
  const payloads = new WeakMap<CapturedCommunityFrame, string | Buffer>()
  let activeClient: WebSocketRoute | undefined
  await context.routeWebSocket(/.*/, (client: WebSocketRoute) => {
    activeClient = client
    const server = client.connectToServer()
    if (options.stripCommunityBatchCapability) {
      client.onMessage((message) => {
        try {
          const value = JSON.parse(message.toString()) as Record<string, unknown>
          if (value.type === "auth" && Array.isArray(value.capabilities)) {
            const capabilities = value.capabilities.filter(
              (capability) => capability !== "community-events-batch-v1",
            )
            const forwarded: Record<string, unknown> = { ...value, capabilities }
            if (capabilities.length === 0) delete forwarded.capabilities
            server.send(JSON.stringify(forwarded))
            return
          }
        } catch {}
        server.send(message)
      })
    }
    server.onMessage((message) => {
      const frame = parseCommunityFrame(message)
      if (frame) {
        frames.push(frame)
        payloads.set(frame, message)
        const decision = options.decide?.(frame) ?? "forward"
        if (decision === "drop") return
        if (decision === "hold") {
          held.push({ client, frame, message })
          return
        }
        client.send(message)
        if (decision === "duplicate") client.send(message)
        return
      }
      client.send(message)
    })
  })
  return {
    frames,
    heldCount: () => held.length,
    releaseHeld: (predicate = () => true) => {
      let released = 0
      for (let index = 0; index < held.length;) {
        const item = held[index]!
        if (!predicate(item.frame)) {
          index += 1
          continue
        }
        held.splice(index, 1)
        item.client.send(item.message)
        released += 1
      }
      return released
    },
    replay: (frame) => {
      const message = payloads.get(frame)
      if (!message || !activeClient) throw new Error("community frame is not replayable")
      activeClient.send(message)
    },
  }
}

export function communityFrameEvents(frame: CapturedCommunityFrame): CapturedCommunityFrame[] {
  return frame.type === "community:events.batch" && Array.isArray(frame.events)
    ? frame.events
    : [frame]
}

// Frozen compatibility surface from the pre-change browser at f1090ebe. The
// dispatcher may change internal batching, but these exact browser-v1 shapes
// must remain consumable without a new wire event.
const F1090EBE_TYPES = new Set([
  "community:message.create",
  "community:unread.bump",
  "community:mention.create",
  "community:channel.member_add",
  "community:channel.child_update",
])

export function frozenF1090ebeDecoderAccepts(frame: CapturedCommunityFrame): boolean {
  if (frame.contractVersion !== 1 || !F1090EBE_TYPES.has(frame.type)) return false
  if (frame.type === "community:message.create") {
    return typeof frame.channelId === "string"
      && typeof frame.message?.id === "string"
      && typeof frame.message.seq === "number"
      && typeof frame.message.content === "string"
  }
  if (frame.type === "community:unread.bump") {
    return typeof frame.channelId === "string"
      && typeof frame.userId === "string"
      && typeof frame.isMention === "boolean"
  }
  if (frame.type === "community:mention.create") {
    return typeof frame.channelId === "string"
      && typeof frame.messageId === "string"
      && typeof frame.userId === "string"
  }
  if (frame.type === "community:channel.member_add") {
    return typeof frame.channelId === "string"
      && typeof frame.serverId === "string"
      && typeof frame.userId === "string"
  }
  return typeof frame.channelId === "string"
    && typeof frame.parentChannelId === "string"
    && typeof frame.changes === "object"
    && frame.changes !== null
}
