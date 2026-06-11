import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, ActivateTokenRequestSchema, createLogger } from "@alook/shared";
import { getDb } from "@/lib/db"
import { writeJSON } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

const log = createLogger({ service: "machine-tokens/activate" });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return writeJSON({ error: "invalid request body" }, 400);
  }

  const parsed = ActivateTokenRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return writeJSON({ error: "invalid payload", details: parsed.error.flatten() }, 400);
  }

  const { token, hostname, runtimes } = parsed.data;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const mt = await queries.machineToken.getMachineTokenByToken(db, token);
  if (!mt) {
    return writeJSON({ error: "token not found" }, 404);
  }
  if (mt.status !== "pending") {
    return writeJSON({ error: "token already used" }, 409);
  }

  const workspaceId = mt.workspaceId;
  if (!workspaceId) {
    return writeJSON({ error: "token has no workspace_id — create workspace first" }, 422);
  }

  const daemonId = hostname;

  await queries.machine.upsertMachine(db, {
    daemonId,
    workspaceId,
    deviceInfo: hostname,
    lastSeenAt: null,
  });

  const results = [];
  for (const rt of runtimes) {
    const result = await queries.runtime.upsertAgentRuntime(db, {
      workspaceId,
      daemonId,
      runtimeMode: "local",
      provider: rt.type,
      deviceInfo: hostname,
      metadata: { version: rt.version || "" },
    });
    results.push({ ...result, machineLastSeenAt: null });
  }

  await queries.machineToken.activateMachineToken(db, mt.id, hostname);

  await Promise.all([
    invalidate(cacheKeys.machineToken(token)),
    invalidate(cacheKeys.runtimeIds(workspaceId, daemonId)),
    invalidate(cacheKeys.allRuntimes(workspaceId)),
  ]);

  broadcastToUser(mt.userId, {
    type: "runtime.registered",
    daemonId,
    hostname,
    workspaceId,
  }).catch((err) => {
    log.warn("broadcast after activation failed", {
      userId: mt.userId,
      daemonId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return writeJSON({
    daemon_id: daemonId,
    workspace_id: workspaceId,
    runtimes: results.map(runtimeToResponse),
  });
}
