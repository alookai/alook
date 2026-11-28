import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_EVENTS } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  getBotOwnedBy: vi.fn(),
  transitionMachineSessionEpoch: vi.fn(),
  updateBotImDaemonStatus: vi.fn(),
  notify: vi.fn(),
}))

vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createDb: () => ({}),
    queries: {
      ...actual.queries,
      communityBot: { getBotOwnedBy: mocks.getBotOwnedBy },
      communityMachineSession: { transitionMachineSessionEpoch: mocks.transitionMachineSessionEpoch },
      communityBotWebhook: { updateBotImDaemonStatus: mocks.updateBotImDaemonStatus },
    },
  }
})
vi.mock("./presence-typing", () => ({ notifyUserDO: mocks.notify }))

import { getCachedImQrStatus, handleImStatusFrame, waitForImQrStart } from "./machine-im"

function makeContext() {
  const store = new Map<string, unknown>()
  return {
    ctx: {
      storage: {
        get: vi.fn(async (k: string) => store.get(k)),
        put: vi.fn(async (k: string, v: unknown) => {
          store.set(k, v)
        }),
      },
    },
    env: { DB: {} },
    log: { warn: vi.fn() },
  } as any
}

const identity = { userId: "owner_1", machineId: "mach_1", credentialHash: "hash_1" }

describe("ws-do machine-im handler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBotOwnedBy.mockResolvedValue({ id: "bot_1", machineId: "mach_1" })
    mocks.transitionMachineSessionEpoch.mockResolvedValue({ type: "ok" })
    mocks.updateBotImDaemonStatus.mockResolvedValue({})
  })

  it("caches QR status, persists durable status, resolves waiter, and broadcasts community:bot.im_status", async () => {
    const context = makeContext()
    const waitPromise = waitForImQrStart(
      context,
      {
        type: "im:qr_start",
        requestId: "req_1",
        botId: "bot_1",
        triggerId: "bwh_1",
        provider: "wechat",
      },
      () => ({ sent: 1, unsupported: 0 }),
    )

    const handled = await handleImStatusFrame(
      context,
      {
        type: "im_status",
        requestId: "req_1",
        botId: "bot_1",
        triggerId: "bwh_1",
        provider: "wechat",
        status: "pending",
        sessionId: "qr_sess_1",
        qrUrl: "https://ilinkai.weixin.qq.com/qr/1",
        expiresAt: "2030-01-01T00:05:00.000Z",
      },
      identity,
    )
    expect(handled).toBe(true)

    const waited = await waitPromise
    expect(waited.ok).toBe(true)
    if (waited.ok) {
      expect(waited.frame.qrUrl).toBe("https://ilinkai.weixin.qq.com/qr/1")
    }

    const cached = await getCachedImQrStatus(context, "bwh_1")
    expect(cached?.qrStatus).toBe("pending")
    expect(cached?.sessionId).toBe("qr_sess_1")
    expect(mocks.updateBotImDaemonStatus).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledWith(
      context,
      "owner_1",
      expect.objectContaining({
        type: WS_EVENTS.BOT_IM_STATUS,
        machineId: "mach_1",
        botId: "bot_1",
        triggerId: "bwh_1",
        status: "pending",
      }),
    )

    // Confirmed status persists connected + botAccountLabel in D1.
    await handleImStatusFrame(
      context,
      {
        type: "im_status",
        botId: "bot_1",
        triggerId: "bwh_1",
        provider: "wechat",
        status: "confirmed",
        botAccountLabel: "wx_bot@im.bot",
      },
      identity,
    )
    expect(mocks.updateBotImDaemonStatus).toHaveBeenCalledWith(
      expect.anything(),
      "owner_1",
      "bot_1",
      "bwh_1",
      expect.objectContaining({
        daemonStatus: "connected",
        botAccountLabel: "wx_bot@im.bot",
        daemonLastError: null,
      }),
    )
  })

  it("drops frames when bot is bound to a different machine or epoch is stale", async () => {
    const context = makeContext()
    mocks.getBotOwnedBy.mockResolvedValueOnce({ id: "bot_1", machineId: "mach_other" })
    expect(
      await handleImStatusFrame(
        context,
        {
          type: "im_status",
          botId: "bot_1",
          triggerId: "bwh_1",
          provider: "wechat",
          status: "session_expired",
        },
        identity,
      ),
    ).toBe(true)
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.updateBotImDaemonStatus).not.toHaveBeenCalled()

    mocks.transitionMachineSessionEpoch.mockResolvedValueOnce({ type: "stale_epoch" })
    await handleImStatusFrame(
      context,
      {
        type: "im_status",
        botId: "bot_1",
        triggerId: "bwh_1",
        provider: "wechat",
        status: "session_expired",
      },
      identity,
    )
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
