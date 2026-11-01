import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextRequest } from "next/server"
import { AutomationPermissionPolicySchema, queries, type AutomationPermission } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { wsDoFetch } from "@/lib/broadcast"
import { writeError } from "@/lib/middleware/helpers"
import { humanAuthPolicy, type AuthContext } from "@/lib/middleware/auth"
import { withAuth, type AuthPolicy } from "@/lib/middleware/auth-policy"

export async function hashAutomationSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function newAutomationSecret(): string {
  return "aac_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const automationManagementPolicy: AuthPolicy<AuthContext> = {
  ...humanAuthPolicy,
  preflight: req => req.headers.has("Authorization")
    ? writeError("Sign in to manage access codes", 401)
    : humanAuthPolicy.preflight?.(req) ?? null,
  respond: (req, response) => req.headers.has("Authorization")
    ? response
    : humanAuthPolicy.respond!(req, response),
}

type AutomationContext = { env: Env; userId: string; beforeCreate: () => Promise<Response | null> }

function readAutomationSecret(req: NextRequest): string | undefined {
  return /^Bearer (aac_[a-f0-9]{64})$/.exec(req.headers.get("Authorization") ?? "")?.[1]
}

type AutomationExpiryContext = { db: ReturnType<typeof getPrimaryDb>; secretHash: string }

const automationExpiryPolicy: AuthPolicy<AutomationExpiryContext> = {
  params: "ignore",
  resolve: async req => {
    const secret = readAutomationSecret(req)
    if (!secret) return writeError("Invalid or unauthorized access code", 401)
    try {
      const env = (await getCloudflareContext({ async: true })).env as Env
      return { context: { db: getPrimaryDb(env.DB), secretHash: await hashAutomationSecret(secret) } }
    } catch { return writeError("Automation expiration unavailable", 503) }
  },
}

export const expireAutomationAccessCode = withAuth(automationExpiryPolicy, async (_req, ctx) => {
  try {
    const expired = await queries.automation.expireAccessCode(ctx.db, ctx.secretHash)
    return Response.json(expired ? { expired: true } : { error: "Invalid or unauthorized access code" }, {
      status: expired ? 200 : 401, headers: { "Cache-Control": "no-store" },
    })
  } catch { return writeError("Automation expiration unavailable", 503) }
})

export function automationPolicy(permission: AutomationPermission): AuthPolicy<AutomationContext> {
  return {
    params: "afterAuth",
    resolve: async req => {
      const secret = readAutomationSecret(req)
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
      return {
        context: { env, userId: access.ownerId, beforeCreate },
        finish: response => {
          response.headers.set("Cache-Control", "no-store")
          return response
        },
      }
    },
  }
}
