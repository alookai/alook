import {
  createDb,
  ImStatusFrameSchema,
  queries,
  WS_EVENTS,
  type BotImDaemonStatus,
  type BotImQrStatus,
  type ImQrStartCommand,
  type ImStatusFrame,
} from "@alook/shared"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
import { notifyUserDO } from "./presence-typing"

const IM_QR_CACHE_PREFIX = "im-qr:"
const IM_QR_WAIT_TIMEOUT_MS = 15_000
const IM_QR_CACHE_TTL_MS = 10 * 60 * 1000

export interface CachedImQrState {
  triggerId: string
  botId: string
  qrStatus: BotImQrStatus
  sessionId: string | null
  qrUrl: string | null
  expiresAt: string | null
  botAccountLabel: string | null
  error: string | null
  updatedAtMs: number
}

interface PendingQrWaiter {
  resolve: (frame: ImStatusFrame) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingQrWaiters = new Map<string, PendingQrWaiter>()

function imQrCacheKey(triggerId: string): string {
  return `${IM_QR_CACHE_PREFIX}${triggerId}`
}

function toDaemonStatus(status: ImStatusFrame["status"]): BotImDaemonStatus | null {
  if (status === "confirmed" || status === "connected") return "connected"
  if (status === "session_expired") return "session_expired"
  if (status === "scan_required") return "scan_required"
  if (status === "error") return "error"
  return null
}

function toQrStatus(status: ImStatusFrame["status"]): BotImQrStatus {
  if (status === "pending" || status === "scanned" || status === "confirmed" || status === "expired" || status === "error") {
    return status
  }
  if (status === "connected") return "confirmed"
  return "idle"
}

export async function getCachedImQrStatus(
  context: WsDurableContext,
  triggerId: string,
): Promise<CachedImQrState | null> {
  const cached = await context.ctx.storage.get<CachedImQrState>(imQrCacheKey(triggerId))
  if (!cached) return null
  if (Date.now() - cached.updatedAtMs > IM_QR_CACHE_TTL_MS) return null
  if (cached.qrStatus === "pending" && cached.expiresAt) {
    const expMs = Date.parse(cached.expiresAt)
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      return { ...cached, qrStatus: "expired" }
    }
  }
  return cached
}

export async function waitForImQrStart(
  context: WsDurableContext,
  command: ImQrStartCommand,
  dispatch: () => { sent: number; unsupported: number },
): Promise<
  | { ok: true; frame: ImStatusFrame }
  | { ok: false; code: "machine_offline" | "unsupported" | "timeout" }
> {
  const waiterKey = `${command.botId}:${command.triggerId}:${command.requestId}`
  let resolveWaiter!: (frame: ImStatusFrame | null) => void
  const promise = new Promise<ImStatusFrame | null>((resolve) => {
    resolveWaiter = resolve
  })

  const timer = setTimeout(() => {
    pendingQrWaiters.delete(waiterKey)
    resolveWaiter(null)
  }, IM_QR_WAIT_TIMEOUT_MS)

  pendingQrWaiters.set(waiterKey, {
    resolve: (frame) => {
      clearTimeout(timer)
      pendingQrWaiters.delete(waiterKey)
      resolveWaiter(frame)
    },
    timer,
  })

  const receipt = dispatch()
  if (receipt.sent === 0) {
    clearTimeout(timer)
    pendingQrWaiters.delete(waiterKey)
    return { ok: false, code: receipt.unsupported > 0 ? "unsupported" : "machine_offline" }
  }

  const frame = await promise
  if (!frame) {
    return { ok: false, code: "timeout" }
  }
  return { ok: true, frame }
}

export async function handleImStatusFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "im_status") {
    return false
  }
  const input = ImStatusFrameSchema.safeParse(parsed)
  if (!input.success) return true

  try {
    const db = createDb(context.env.DB)
    const bot = await queries.communityBot.getBotOwnedBy(db, input.data.botId, identity.userId)
    if (bot?.machineId !== identity.machineId) return true
    const epoch = await queries.communityMachineSession.transitionMachineSessionEpoch(db, {
      type: "renew",
      epoch: identity,
    })
    if (epoch.type === "stale_epoch") return true

    const nowMs = Date.now()
    const prev = await context.ctx.storage.get<CachedImQrState>(imQrCacheKey(input.data.triggerId))
    const nextCache: CachedImQrState = {
      triggerId: input.data.triggerId,
      botId: input.data.botId,
      qrStatus: toQrStatus(input.data.status),
      sessionId: input.data.sessionId !== undefined ? input.data.sessionId : (prev?.sessionId ?? null),
      qrUrl: input.data.qrUrl !== undefined ? input.data.qrUrl : (prev?.qrUrl ?? null),
      expiresAt: input.data.expiresAt !== undefined ? input.data.expiresAt : (prev?.expiresAt ?? null),
      botAccountLabel:
        input.data.botAccountLabel !== undefined
          ? input.data.botAccountLabel
          : (prev?.botAccountLabel ?? null),
      error: input.data.error !== undefined ? input.data.error : null,
      updatedAtMs: nowMs,
    }
    await context.ctx.storage.put(imQrCacheKey(input.data.triggerId), nextCache)

    const durableStatus = toDaemonStatus(input.data.status)
    if (durableStatus !== null) {
      await queries.communityBotWebhook.updateBotImDaemonStatus(
        db,
        identity.userId,
        input.data.botId,
        input.data.triggerId,
        {
          daemonStatus: durableStatus,
          ...(input.data.botAccountLabel !== undefined
            ? { botAccountLabel: input.data.botAccountLabel }
            : {}),
          daemonLastError:
            durableStatus === "connected" ? null : (input.data.error ?? null),
          nowMs,
        },
      )
    }

    if (input.data.requestId) {
      const waiterKey = `${input.data.botId}:${input.data.triggerId}:${input.data.requestId}`
      const waiter = pendingQrWaiters.get(waiterKey)
      if (waiter) {
        waiter.resolve(input.data)
      }
    }

    await notifyUserDO(context, identity.userId, {
      type: WS_EVENTS.BOT_IM_STATUS,
      machineId: identity.machineId,
      botId: input.data.botId,
      triggerId: input.data.triggerId,
      provider: input.data.provider,
      status: input.data.status,
      ...(input.data.sessionId !== undefined ? { sessionId: input.data.sessionId } : {}),
      ...(input.data.qrUrl !== undefined ? { qrUrl: input.data.qrUrl } : {}),
      ...(input.data.expiresAt !== undefined ? { expiresAt: input.data.expiresAt } : {}),
      ...(input.data.botAccountLabel !== undefined ? { botAccountLabel: input.data.botAccountLabel } : {}),
      ...(input.data.error !== undefined ? { error: input.data.error } : {}),
    })
  } catch {
    context.log.warn("IM status frame unavailable", { machineId: identity.machineId })
  }
  return true
}
