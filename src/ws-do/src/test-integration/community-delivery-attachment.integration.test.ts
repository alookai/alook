import { env } from "cloudflare:workers"
import { evictDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import {
  appendSixtyFifthOperation,
  buildMaxCommunityConnectionState,
  type AttachmentProbeEnv,
} from "./community-delivery-attachment-worker"

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", event => resolve(event.data as string), { once: true })
    socket.addEventListener("error", () => reject(new Error("attachment probe socket failed")), { once: true })
  })
}

async function sendAndRead(socket: WebSocket, command: string): Promise<unknown> {
  const message = nextMessage(socket)
  socket.send(command)
  return JSON.parse(await message)
}

describe("community delivery attachment in the Workers runtime", () => {
  it("serializes 64 cursors and preserves 65th eviction across hibernation", async () => {
    const probeEnv = env as unknown as AttachmentProbeEnv
    const id = probeEnv.ATTACHMENT_PROBE.idFromName("community-delivery-attachment")
    const stub = probeEnv.ATTACHMENT_PROBE.get(id)
    const response = await stub.fetch("https://attachment.test", {
      headers: { Upgrade: "websocket" },
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (!socket) throw new Error("Expected attachment probe WebSocket")
    socket.accept()

    const maxState = buildMaxCommunityConnectionState()
    await evictDurableObject(stub)
    expect(await sendAndRead(socket, "read")).toEqual(maxState)

    const evictedState = appendSixtyFifthOperation(maxState)
    expect(await sendAndRead(socket, "append-65th")).toEqual(evictedState)
    expect(evictedState.communityDeliveryProgress).toHaveLength(64)
    expect(evictedState.communityDeliveryProgress?.[0]).toEqual(maxState.communityDeliveryProgress?.[1])

    await evictDurableObject(stub)
    expect(await sendAndRead(socket, "read")).toEqual(evictedState)
    socket.close(1000, "done")
  })
})
