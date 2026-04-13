import { vi } from "vitest"

// --- DurableObjectState context mock ---

export function createMockCtx() {
  const webSockets: MockWebSocket[] = []

  const acceptWebSocket = vi.fn((ws: MockWebSocket) => {
    webSockets.push(ws)
  })
  const getWebSockets = vi.fn(() => webSockets)
  const setWebSocketAutoResponse = vi.fn()

  return {
    ctx: { acceptWebSocket, getWebSockets, setWebSocketAutoResponse } as unknown as DurableObjectState,
    acceptWebSocket,
    getWebSockets,
    setWebSocketAutoResponse,
    webSockets,
  }
}

// --- WebSocket mock ---

export interface MockWebSocket {
  readyState: number
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  serializeAttachment: ReturnType<typeof vi.fn>
  deserializeAttachment: ReturnType<typeof vi.fn>
  _attachment: unknown
}

export function createMockWebSocket(readyState = WebSocket.OPEN): MockWebSocket {
  let attachment: unknown = null
  const ws: MockWebSocket = {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((val: unknown) => { attachment = val }),
    deserializeAttachment: vi.fn(() => attachment),
    _attachment: null,
  }
  // Keep _attachment as a getter for test inspection
  Object.defineProperty(ws, "_attachment", { get: () => attachment })
  return ws
}

// --- WebSocketPair mock ---

export function createMockWebSocketPair() {
  const client = createMockWebSocket()
  const server = createMockWebSocket()
  return { client, server, pair: [client, server] }
}

// --- DurableObjectNamespace / Stub mock ---

export function createMockDONamespace() {
  const stubFetch = vi.fn().mockResolvedValue(new Response("ok"))
  const stub = { fetch: stubFetch } as unknown as DurableObjectStub
  const get = vi.fn().mockReturnValue(stub)
  const idFromName = vi.fn().mockReturnValue("mock-do-id")

  return {
    namespace: { idFromName, get } as unknown as DurableObjectNamespace,
    idFromName,
    get,
    stub,
    stubFetch,
  }
}
