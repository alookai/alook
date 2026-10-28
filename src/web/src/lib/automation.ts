import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextRequest } from "next/server"
import { AutomationPermissionPolicySchema, queries, type AutomationPermission } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { wsDoFetch } from "@/lib/broadcast"
import { writeError } from "@/lib/middleware/helpers"
import { withAuth, type AuthenticatedHandler } from "@/lib/middleware/auth"

export async function hashAutomationSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function newAutomationSecret(): string {
  return "aac_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function withAutomationManagement(handler: AuthenticatedHandler) {
  const authenticated = withAuth(handler)
  return (...args: Parameters<typeof authenticated>) => args[0].headers.has("Authorization")
    ? Promise.resolve(writeError("Sign in to manage access codes", 401))
    : authenticated(...args)
}

type RouteContext = { params?: Promise<Record<string, string>> | Record<string, string> }
type AutomationHandler = (req: NextRequest, ctx: { env: Env; userId: string; params?: Record<string, string>; beforeCreate: () => Promise<Response | null> }) => Promise<Response>

export function withAutomation(permission: AutomationPermission, handler: AutomationHandler) {
  return async (req: NextRequest, context?: RouteContext): Promise<Response> => {
    const secret = /^Bearer (aac_[a-f0-9]{64})$/.exec(req.headers.get("Authorization") ?? "")?.[1]
    if (!secret) return writeError("Invalid or unauthorized access code", 401)
    let env: Env
    let access: Awaited<ReturnType<typeof queries.automation.authenticateAccessCode>>
    try {
      env = (await getCloudflareContext({ async: true })).env as Env
      access = await queries.automation.authenticateAccessCode(getPrimaryDb(env.DB), await hashAutomationSecret(secret), permission)
    } catch { return writeError("Automation authentication unavailable", 503) }
    if (!access) return writeError("Invalid or unauthorized access code", 401)
    const policy = AutomationPermissionPolicySchema.safeParse({ permission, limit: access.limit, period: access.period })
    if (!policy.success) return writeError("Automation policy unavailable", 503)
    const beforeCreate = async (): Promise<Response | null> => {
      try {
        const res = await wsDoFetch(env, "/rate-limit/automation", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: permission, key: access.codeId, max: policy.data.limit, period: policy.data.period }),
        }, { type: "automation-limit" })
        if (!res.ok) return writeError("Automation rate limiter unavailable", 503)
        const result: unknown = await res.json()
        if (typeof result !== "object" || result === null || !("allowed" in result)) return writeError("Automation rate limiter unavailable", 503)
        if (result.allowed === true) return null
        if (result.allowed === false && "retryAfterSec" in result && typeof result.retryAfterSec === "number" && Number.isFinite(result.retryAfterSec) && result.retryAfterSec > 0) {
          return writeError("Automation rate limit exceeded", 429, { "Retry-After": String(Math.ceil(result.retryAfterSec)) })
        }
      } catch { }
      return writeError("Automation rate limiter unavailable", 503)
    }
    const params = await context?.params
    const response = await handler(req, { env, userId: access.ownerId, params, beforeCreate })
    response.headers.set("Cache-Control", "no-store")
    return response
  }
}

export function withAutomationOrExistingAuth(
  permission: AutomationPermission,
  handler: AutomationHandler,
  existing: (req: NextRequest, context?: { params?: Promise<Record<string, string>> | Record<string, string> }) => Promise<Response>,
) {
  const automation = withAutomation(permission, handler)
  return (req: NextRequest, context?: { params?: Promise<Record<string, string>> | Record<string, string> }) =>
    req.headers.get("Authorization")?.startsWith("Bearer aac_") ? automation(req, context) : existing(req, context)
}
