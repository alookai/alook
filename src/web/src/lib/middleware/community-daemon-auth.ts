import type { AuthPolicy } from "./auth-policy"
import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"

interface CommunityDaemonAuthContext {
  env: Env
  userId: string
  machineId: string
  credentialId: string
}

/**
 * Community-daemon auth middleware. Requires `Authorization: Bearer cmk_…`;
 * validates against `community_machine_credential` (revoked_at IS NULL),
 * attaches `{ userId, machineId, credentialId }` to the handler ctx.
 *
 * Rejects with 401 on missing header, wrong prefix, or unknown/revoked
 * credential. Response body is `{ error: string }`, matching the plan's
 * wire contract.
 */
export const machineAuthPolicy: AuthPolicy<CommunityDaemonAuthContext> = {
  resolve: async req => {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "missing or malformed Authorization header" }, { status: 401 })
    }
    const raw = authHeader.slice(7).trim()
    if (!raw.startsWith("cmk_")) {
      return NextResponse.json({ error: "invalid credential prefix" }, { status: 401 })
    }

    const { env } = await getCloudflareContext({ async: true })
    const cloudflareEnv = env as Env
    const db = getDb(cloudflareEnv.DB)

    const active = await withD1Retry(
      () => queries.communityMachine.findActiveCredentialByBearer(db, raw),
      { route: "community/daemon-auth:credential" }
    )
    if (!active) {
      return NextResponse.json({ error: "credential revoked or unrecognized" }, { status: 401 })
    }

    return {
      context: {
        env: cloudflareEnv,
        userId: active.userId,
        machineId: active.machineId,
        credentialId: active.credentialId,
      },
    }
  },
}
