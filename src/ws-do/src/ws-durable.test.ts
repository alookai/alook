import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMockWebSocket } from "./__mocks__/cf"
import {
  cleanupHarness,
  createDO,
  mockGetBotBinding,
  mockLogWarn,
  mockUpdateProfile,
  resetHarness,
} from "./ws-durable/test-harness"

describe("WebSocketDurableObject", () => {
  beforeEach(() => resetHarness())
  afterEach(() => cleanupHarness())

  describe("C2c characterization — machine frames", () => {
    function machineWs() {
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })
      return ws
    }

    it("drops inbound frames before parsing when the cached identity is missing", async () => {
      const { durable, storage } = createDO()

      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" }),
      )

      expect(storage.get).toHaveBeenCalledWith("community-machine-identity")
      expect(mockGetBotBinding).not.toHaveBeenCalled()
      expect(mockUpdateProfile).not.toHaveBeenCalled()
      expect(mockLogWarn).toHaveBeenCalledWith("community machine message with no cached identity")
    })
  })
})
