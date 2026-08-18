import type { BrowserContext, WebSocketRoute } from "@playwright/test"

export type CapturedCommunityFrame = {
  type: string
  contractVersion?: number
  channelId?: string
  parentChannelId?: string
  messageId?: string
  message?: { id?: string; seq?: number; content?: string }
  [key: string]: unknown
}

type FrameDecision = (frame: CapturedCommunityFrame) => "drop" | "forward"

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

/**
 * Test-only transparent WS proxy. It records community browser-v1 frames and
 * can drop selected server frames without adding a production fault hook.
 */
export async function proxyCommunityWebSockets(
  context: BrowserContext,
  decide: FrameDecision = () => "forward",
): Promise<CapturedCommunityFrame[]> {
  const frames: CapturedCommunityFrame[] = []
  await context.routeWebSocket(/.*/, (client: WebSocketRoute) => {
    const server = client.connectToServer()
    server.onMessage((message) => {
      const frame = parseCommunityFrame(message)
      if (frame) {
        frames.push(frame)
        if (decide(frame) === "drop") return
      }
      client.send(message)
    })
  })
  return frames
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
