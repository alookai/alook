import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMockWebSocket } from "../__mocks__/cf"
import {
  CFResponse,
  cleanupHarness,
  createDO,
  flushAsyncWork,
  mockCheckAliveFetch,
  mockCreateDb,
  mockFindCredentialByHash,
  mockGetBotBinding,
  mockGetBotBindingWithOwner,
  mockGetChannelForMember,
  mockGetChannelType,
  mockGetCoMemberUserIds,
  mockGetDM,
  mockGetFriendUserIds,
  mockGetLatestTokenForUser,
  mockGetMachineByDaemon,
  mockGetMachineByIdForUser,
  mockGetMachineTokenByToken,
  mockGetPrivateChannelAudienceUserIds,
  mockGetProfile,
  mockGetRuntimeIdsByDaemon,
  mockGetUserInternal,
  mockGetValidSession,
  mockGetValidSessionWithIdentity,
  mockHashCredential,
  mockInsertBotActivityEventAndPrune,
  mockInsertBotAuditModelChanged,
  mockInsertBotAuditNap,
  mockInsertBotAuditProviderChanged,
  mockInsertBotAuditSessionReset,
  mockIsBotOnline,
  mockIsChannelPrivate,
  mockListBotsForMachine,
  mockListChannelMemberUserIds,
  mockListMembers,
  mockListThreadParticipantUserIds,
  mockMarkMachineOffline,
  mockMarkMachineOnlineIfOffline,
  mockReconcileBotActivityFromRunningAgents,
  mockResolveScopeMemberUserIds,
  mockStubFetch,
  mockToSummary,
  mockTouchBotRefreshContext,
  mockTouchMachineHeartbeat,
  mockUpdateProfile,
  mockUpsertMachineByMachineId,
  resetHarness
} from "./test-harness"

describe("WebSocketDurableObject", () => {
  beforeEach(() => resetHarness())
  afterEach(() => cleanupHarness())

  describe("community-machine — session.error overlay + optimistic clear", () => {
    beforeEach(() => {
          mockFindCredentialByHash.mockReset()
          mockGetMachineByIdForUser.mockReset()
          mockStubFetch.mockClear()
        })

    it("forceClose closes attachments and clears identity+overlay", async () => {
          const { durable, ctx, store, getWebSockets } = createDO()
          store.set("community-machine-identity", {
            userId: "u_1",
            machineId: "cm_1",
            credentialHash: "0".repeat(64),
          })
          store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
          store.set("community-machine-runtime-error", {
            requested: "unknown-runtime",
            available: [],
            at: "2026-07-06T00:00:00.000Z",
          })
          mockGetMachineByIdForUser.mockResolvedValue({
            id: "cm_1",
            hostname: "host",
            availableRuntimes: [],
          })

          const ws = createMockWebSocket()
          ws.serializeAttachment({
            type: "community-machine",
            machineId: "cm_1",
            userId: "u_1",
            authenticated: true,
          })
          getWebSockets.mockReturnValue([ws])

          const req = new Request("http://internal/force-close", { method: "POST" })
          const res = await durable.fetch(req)
          expect(res.status).toBe(200)
          expect(ws.send).toHaveBeenCalled()
          expect(ws.close).toHaveBeenCalledWith(1008, "Revoked")

          // Cached identity + handle + overlay all cleared.
          expect(store.get("community-machine-identity")).toBeUndefined()
          expect(store.get("community-machine-handle")).toBeUndefined()
          expect(store.get("community-machine-runtime-error")).toBeUndefined()
        })
  })

  describe("C2b characterization — machine control", () => {
      const auth = {
        credentialId: "cred_1",
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "f".repeat(64),
        doName: "do_1",
      }

      beforeEach(() => {
        mockHashCredential.mockReset().mockImplementation(async (bearer: string) => `hash:${bearer}`)
        mockFindCredentialByHash.mockReset()
      })

      it("accepts cmk credentials in exact lookup, socket, attachment, storage, and alarm order", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000_000)
        mockFindCredentialByHash.mockResolvedValue(auth)
        const { durable, ctx, storage } = createDO()

        const response = await durable.fetch(new Request("http://internal/", {
          headers: {
            Upgrade: "websocket",
            Authorization: "Bearer cmk_secret",
          },
        })) as unknown as CFResponse

        expect(response.status).toBe(101)
        expect(mockHashCredential).toHaveBeenCalledWith("cmk_secret")
        expect(mockFindCredentialByHash).toHaveBeenCalledWith({}, "hash:cmk_secret")
        expect(ctx.acceptWebSocket).toHaveBeenCalledTimes(1)
        const server = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0]![0]
        expect(server.serializeAttachment).toHaveBeenCalledWith({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        expect(storage.put.mock.calls).toEqual([
          ["community-machine-identity", {
            userId: "u_1",
            machineId: "cm_1",
            credentialHash: "f".repeat(64),
          }],
          ["community-machine-handle", { userId: "u_1", machineId: "cm_1" }],
        ])
        expect(storage.setAlarm).toHaveBeenCalledWith(1_060_000)
        const order = [
          mockHashCredential.mock.invocationCallOrder[0],
          mockFindCredentialByHash.mock.invocationCallOrder[0],
          (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
          server.serializeAttachment.mock.invocationCallOrder[0],
          storage.put.mock.invocationCallOrder[0],
          storage.put.mock.invocationCallOrder[1],
          storage.getAlarm.mock.invocationCallOrder[0],
          storage.setAlarm.mock.invocationCallOrder[0],
        ]
        expect(order).toEqual([...order].sort((a, b) => a - b))
      })

      it("returns 503 before accepting or persisting when cmk auth lookup throws", async () => {
        mockFindCredentialByHash.mockRejectedValue(new Error("d1 unavailable"))
        const { durable, ctx, storage } = createDO()

        const response = await durable.fetch(new Request("http://internal/", {
          headers: { Upgrade: "websocket", Authorization: "Bearer cmk_secret" },
        }))

        expect(response.status).toBe(503)
        expect(ctx.acceptWebSocket).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
        expect(storage.setAlarm).not.toHaveBeenCalled()
      })

      it("returns 401 before accepting or persisting a revoked cmk credential", async () => {
        mockFindCredentialByHash.mockResolvedValue(null)
        const { durable, ctx, storage } = createDO()

        const response = await durable.fetch(new Request("http://internal/", {
          headers: { Upgrade: "websocket", Authorization: "Bearer cmk_revoked" },
        }))

        expect(response.status).toBe(401)
        expect(ctx.acceptWebSocket).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
        expect(storage.setAlarm).not.toHaveBeenCalled()
      })

      it("retains an existing heartbeat alarm that fires earlier than the requested target", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000_000)
        mockFindCredentialByHash.mockResolvedValue(auth)
        const { durable, storage } = createDO()
        await storage.setAlarm(1_030_000)
        storage.setAlarm.mockClear()

        const response = await durable.fetch(new Request("http://internal/", {
          headers: { Upgrade: "websocket", Authorization: "Bearer cmk_secret" },
        }))

        expect(response.status).toBe(101)
        expect(storage.getAlarm).toHaveBeenCalledTimes(1)
        expect(storage.setAlarm).not.toHaveBeenCalled()
        expect(await storage.getAlarm()).toBe(1_030_000)
      })

      it("sets a null or later alarm to the exact heartbeat target", async () => {
        vi.spyOn(Date, "now").mockReturnValue(2_000_000)
        mockFindCredentialByHash.mockResolvedValue(auth)
        const first = createDO()

        await first.durable.fetch(new Request("http://internal/", {
          headers: { Upgrade: "websocket", Authorization: "Bearer cmk_first" },
        }))
        expect(first.storage.setAlarm).toHaveBeenCalledWith(2_060_000)

        const second = createDO()
        await second.storage.setAlarm(2_120_000)
        second.storage.setAlarm.mockClear()
        await second.durable.fetch(new Request("http://internal/", {
          headers: { Upgrade: "websocket", Authorization: "Bearer cmk_second" },
        }))
        expect(second.storage.setAlarm).toHaveBeenCalledWith(2_060_000)
      })

      it("rejects malformed model and provider switch JSON before forwarding or storage", async () => {
        const { durable, getWebSockets, storage } = createDO()

        const model = await durable.fetch(new Request("http://internal/push-model-switch", {
          method: "POST",
          body: "{",
        }))
        const provider = await durable.fetch(new Request("http://internal/push-provider-switch", {
          method: "POST",
          body: "{",
        }))

        expect([model.status, provider.status]).toEqual([400, 400])
        expect(getWebSockets).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
      })

      it("rejects model and provider switches with missing required fields before forwarding or storage", async () => {
        const { durable, getWebSockets, storage } = createDO()
        const request = (path: string) => new Request(`http://internal${path}`, {
          method: "POST",
          body: JSON.stringify({ agentId: "a_1", launchId: "l_1" }),
        })

        const model = await durable.fetch(request("/push-model-switch"))
        const provider = await durable.fetch(request("/push-provider-switch"))

        expect([model.status, provider.status]).toEqual([400, 400])
        expect(getWebSockets).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
      })

      it("rejects invalid model and provider from/to values before forwarding or storage", async () => {
        const { durable, getWebSockets, storage } = createDO()
        const model = await durable.fetch(new Request("http://internal/push-model-switch", {
          method: "POST",
          body: JSON.stringify({ agentId: "a_1", config: {}, launchId: "l_1", from: 1, to: null }),
        }))
        const provider = await durable.fetch(new Request("http://internal/push-provider-switch", {
          method: "POST",
          body: JSON.stringify({ agentId: "a_1", config: {}, launchId: "l_2", from: "", to: "next" }),
        }))

        expect([model.status, provider.status]).toEqual([400, 400])
        expect(getWebSockets).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
      })

      it("stamps and forwards a revisioned runtime config update without restart attribution", async () => {
        const { durable, getWebSockets, storage } = createDO()
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([ws])
        const config = {
          version: 1,
          runtime: "codex",
          model: { kind: "default" },
          mode: { kind: "default" },
          reasoningEffort: "xhigh",
          runtimeConfigRevision: 9,
        }

        const response = await durable.fetch(new Request("http://internal/push-runtime-config-update", {
          method: "POST",
          body: JSON.stringify({ agentId: "a_1", config }),
        }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ sent: 1 })
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
          type: "agent:runtime_config_update",
          agentId: "a_1",
          config,
        }))
        expect(storage.put).not.toHaveBeenCalled()
      })

      it("rejects malformed runtime config update bodies before touching sockets", async () => {
        const { durable, getWebSockets } = createDO()
        const response = await durable.fetch(new Request("http://internal/push-runtime-config-update", {
          method: "POST",
          body: JSON.stringify({ agentId: "a_1", config: {}, extra: true }),
        }))

        expect(response.status).toBe(400)
        expect(getWebSockets).not.toHaveBeenCalled()
      })

      it("returns the forward-wake send count when optimistic overlay clearing rejects", async () => {
        const { durable, getWebSockets, storage } = createDO()
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([ws])
        storage.get.mockRejectedValueOnce(new Error("storage unavailable"))
        const body = JSON.stringify({ type: "agent:wake", agentId: "a_1" })

        const response = await durable.fetch(new Request("http://internal/forward-agent-wake", {
          method: "POST",
          body,
        }))

        await expect(response.json()).resolves.toEqual({ attempted: 1, sent: 1 })
        expect(ws.send).toHaveBeenCalledWith(body)
      })

      it("strictly parses and forwards only the exact diagnostics HostCommand", async () => {
        const { durable, getWebSockets } = createDO()
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([ws])
        const payload = {
          type: "diagnostics:collect",
          reportId: "dbr_0123456789abcdef",
          agentId: "bot_1",
          fromMs: 1_700_000_000_000,
          deadlineAt: 1_700_087_000_000,
        }

        const response = await durable.fetch(new Request("http://internal/forward-diagnostics-collect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ attempted: 1, sent: 1 })
        expect(ws.send).toHaveBeenCalledOnce()
        expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toEqual(payload)
      })

      it("registers a strict machine-keyed diagnostic deadline without forwarding a command", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        const { durable, getWebSockets, store, storage } = createDO()
        getWebSockets.mockReturnValue([])

        const response = await durable.fetch(new Request(
          "http://internal/register-diagnostic-deadline?machineId=cm_1",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deadlineAt: 1_700_087_000_000 }),
          },
        ))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ registered: true })
        expect(store.get("community-machine-diagnostic-alarm-hint")).toEqual({
          machineId: "cm_1",
          deadlineAt: 1_700_087_000_000,
        })
        expect(storage.setAlarm).toHaveBeenCalledWith(1_700_087_000_000)
      })

      it.each([
        ["malformed JSON", "{"],
        ["missing field", JSON.stringify({ type: "diagnostics:collect", agentId: "bot_1" })],
        ["unknown field", JSON.stringify({
          type: "diagnostics:collect",
          reportId: "dbr_0123456789abcdef",
          agentId: "bot_1",
          fromMs: 1_700_000_000_000,
          deadlineAt: 1_700_087_000_000,
          machineId: "cm_injected",
        })],
      ])("rejects diagnostics %s before reading sockets", async (_label, body) => {
        const { durable, getWebSockets } = createDO()

        const response = await durable.fetch(new Request("http://internal/forward-diagnostics-collect", {
          method: "POST",
          body,
        }))

        expect(response.status).toBe(400)
        expect(getWebSockets).not.toHaveBeenCalled()
      })

      it("best-effort force-close counts only sockets whose send and close both complete", async () => {
        const { durable, getWebSockets } = createDO()
        const sendFails = createMockWebSocket()
        const closeFails = createMockWebSocket()
        const completes = createMockWebSocket()
        for (const ws of [sendFails, closeFails, completes]) {
          ws.serializeAttachment({
            type: "community-machine",
            machineId: "cm_1",
            userId: "u_1",
            authenticated: true,
          })
        }
        sendFails.send.mockImplementation(() => { throw new Error("send failed") })
        closeFails.close.mockImplementation(() => { throw new Error("close failed") })
        getWebSockets.mockReturnValue([sendFails, closeFails, completes])

        const response = await durable.fetch(new Request("http://internal/force-close", { method: "POST" }))

        await expect(response.json()).resolves.toEqual({ closed: 1 })
        expect(sendFails.close).not.toHaveBeenCalled()
        expect(closeFails.close).toHaveBeenCalledWith(1008, "Revoked")
        expect(completes.close).toHaveBeenCalledWith(1008, "Revoked")
      })
    })
})
