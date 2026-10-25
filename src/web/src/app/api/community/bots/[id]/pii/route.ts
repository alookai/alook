import { PII_REQUEST_MAX_BYTES, PiiRequestSchema, queries, readBoundedJsonRequest } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { wsDoFetch } from "@/lib/broadcast"

export const POST = withCookieHumanAuth(async (request, context) => {
  const input = await readBoundedJsonRequest(request, PII_REQUEST_MAX_BYTES)
  const payload = PiiRequestSchema.safeParse(input.ok ? input.value : null)
  if (!payload.success) return writeError("INVALID_PII_REQUEST", 400)
  const db = getPrimaryDb(context.env.DB)
  const botId = context.params?.id ?? ""
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, context.userId)
  if (!bot?.machineId) return writeError("BOT_NOT_FOUND", 404)
  const machine = await queries.communityMachine.getMachineByIdForUser(db, context.userId, bot.machineId)
  if (!machine || machine.status !== "online") return writeError("MACHINE_OFFLINE", 409)
  try {
    const response = await wsDoFetch(context.env, `/community-machine/by-id/${encodeURIComponent(machine.id)}/pii`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "pii:manage", botId, ...payload.data }),
    })
    if (!response.ok) return writeError("PII_UNAVAILABLE", 503)
    const receipt = await response.json() as { sent?: unknown; unsupported?: unknown }
    if (typeof receipt.sent !== "number" || !Number.isSafeInteger(receipt.sent) || receipt.sent < 0) return writeError("PII_UNAVAILABLE", 503)
    if (receipt.sent === 0) return writeError(typeof receipt.unsupported === "number" && receipt.unsupported > 0 ? "UPGRADE_REQUIRED" : "MACHINE_OFFLINE", 409)
    const result = writeJSON({ dispatched: true, requestId: payload.data.requestId }, 202)
    result.headers.set("Cache-Control", "no-store")
    return result
  } catch { return writeError("PII_UNAVAILABLE", 503) }
})
