import { z } from "zod"
import type { NextRequest } from "next/server"
import { projectModelOptions } from "@/lib/community/machine-options.server"
import { queries, readBoundedJsonRequest, RuntimeModelDiscoveryRequestSchema, RuntimeModelDiscoveryResultSchema, fingerprintRuntimeModelCatalog, RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { wsDoFetch } from "@/lib/broadcast"

type DiscoveryContext = { env: Env; userId: string; params?: Record<string, string>; beforeCreate?: () => Promise<Response | null> }

export function discoveryFailure(message: string, status: number, machineId: string) {
  const code = message === "MACHINE_OFFLINE" || message === "UPGRADE_REQUIRED" ? message
    : message === "machine not found" ? "MACHINE_NOT_FOUND" : message === "runtime not found" ? "BACKEND_NOT_FOUND"
      : message === "invalid request" ? "INVALID_DISCOVERY_REQUEST" : "DISCOVERY_UNAVAILABLE"
  const text = code === "MACHINE_OFFLINE" ? "Target machine is offline" : code === "UPGRADE_REQUIRED" ? "Target daemon must be upgraded to discover models" : message
  return writeJSON({ error: text, code, machineId }, status)
}

export async function discoverRuntimeModels(req: NextRequest, ctx: DiscoveryContext, wait: boolean, failure: (message: string, status: number) => Response) {
  const id = ctx.params?.id as string
  const machine = await queries.communityMachine.getMachineByIdForUser(getPrimaryDb(ctx.env.DB), ctx.userId, id)
  if (!machine) return failure("machine not found", 404)
  if (machine.status !== "online") return failure("MACHINE_OFFLINE", 409)
  const input = await readBoundedJsonRequest(req, 4096)
  const payload = (wait ? RuntimeModelDiscoveryRequestSchema.extend({ refresh: z.boolean().optional() }) : RuntimeModelDiscoveryRequestSchema).safeParse(input.ok ? input.value : null)
  if (!payload.success) return failure("invalid request", 400)
  const runtime = queries.communityBot.normalizeMachineRuntimes(machine.availableRuntimes).find((runtime) => runtime.id === payload.data.runtimeId)
  if (!runtime) {
    return failure("runtime not found", 400)
  }
  const forceRefresh = "refresh" in payload.data && payload.data.refresh === true
  const discoveryRequest = { requestId: payload.data.requestId, runtimeId: payload.data.runtimeId }
  const denied = await ctx.beforeCreate?.()
  if (denied) return denied
  const catalogFingerprint = wait && !forceRefresh ? await fingerprintRuntimeModelCatalog(runtime.reasoning ?? null) : undefined
  try {
    const response = await wsDoFetch(ctx.env, `/community-machine/by-id/${encodeURIComponent(id)}/discover-models${wait ? `?wait=1${forceRefresh ? "" : "&cache=1"}` : ""}`, {
      method: "POST", headers: { "content-type": "application/json", ...(catalogFingerprint ? { [RUNTIME_MODEL_CATALOG_FINGERPRINT_HEADER]: catalogFingerprint } : {}) }, body: JSON.stringify(discoveryRequest),
    })
    if (!response.ok) return failure("model discovery unavailable", 503)
    const receipt = await response.json() as { sent?: unknown; unsupported?: unknown; result?: unknown; cached?: unknown; observedAt?: unknown; catalogFingerprint?: unknown }
    if (typeof receipt.sent !== "number" || !Number.isSafeInteger(receipt.sent) || receipt.sent < 0) {
      return failure("model discovery unavailable", 503)
    }
    if (receipt.sent > 0 || (wait && receipt.cached === true)) {
      if (!wait) return writeJSON({ dispatched: true, requestId: payload.data.requestId }, 202)
      if (receipt.cached === true && (!catalogFingerprint || receipt.catalogFingerprint !== catalogFingerprint)) return failure("model discovery unavailable", 503)
      const result = RuntimeModelDiscoveryResultSchema.safeParse(receipt.cached === true ? { status: "complete", catalog: runtime.reasoning ?? null } : receipt.result)
      if (!result.success || (receipt.cached === true && result.data.status !== "complete")) return failure("model discovery unavailable", 503)
      if (result.data.status === "error") return writeJSON({ error: result.data.message, code: result.data.code, machineId: id, backendId: payload.data.runtimeId, requestId: payload.data.requestId }, 502)
      if (typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt))) return failure("model discovery unavailable", 503)
      return { machineId: id, backendId: payload.data.runtimeId, requestId: payload.data.requestId,
        source: receipt.cached === true ? "cached_report" : "fresh_discovery", observedAt: receipt.observedAt, result: result.data }

    }
    return failure(typeof receipt.unsupported === "number" && receipt.unsupported > 0 ? "UPGRADE_REQUIRED" : "MACHINE_OFFLINE", 409)
  } catch {
    return failure("model discovery unavailable", 503)
  }
}


export async function discoverModels(req: NextRequest, ctx: DiscoveryContext & { kind: "human" | "bot" }) {
  const query = new URL(req.url).searchParams
  const id = ctx.params?.id as string
  const response = await discoverRuntimeModels(req, ctx, query.get("wait") === "1", (message, status) => ctx.kind === "human" ? writeError(message, status) : discoveryFailure(message, status, id))
  if (response instanceof Response) return response
  if (ctx.kind === "human") return writeJSON(response)
  return writeJSON({ ...projectModelOptions(id, { id: response.backendId, ...(response.result.catalog ? { reasoning: response.result.catalog } : {}) }, query.get("model")), source: response.source, observedAt: response.observedAt, requestId: response.requestId })
}
