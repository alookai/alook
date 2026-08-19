import { describe, expect, it } from "vitest"
import { websocketUrl } from "./websocket-url"

describe("websocketUrl", () => {
  it("routes local users and machines through the web worker", () => {
    const options = { local: true, port: 3000 } as const

    expect(websocketUrl("user", options)).toBe("ws://localhost:3000/api/ws/user")
    expect(websocketUrl("community-daemon", options)).toBe("ws://localhost:3000/api/ws/community-daemon")
  })

  it("uses the public secure websocket origin in production", () => {
    expect(websocketUrl("user", {
      local: false,
      origin: "https://alook.ai",
    })).toBe("wss://alook.ai/api/ws/user")
  })
})
