import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, ActivateTokenRequestSchema, createLogger } from "@alook/shared";
import { getDb } from "@/lib/db"
import { writeJSON } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { broadcastToUser } from "@/lib/broadcast";

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

  // Use hostname as daemonId — must match what the daemon uses (os.hostname())
  // so that daemon start's upsert hits the same records instead of creating duplicates
  const daemonId = hostname;

  // Create machine row with last_seen_at = null (offline by default until daemon starts)
  await queries.machine.upsertMachine(db, {
    daemonId,
    workspaceId: mt.workspaceId,
    deviceInfo: hostname,
    lastSeenAt: null,
  });

  const results = [];
  for (const rt of runtimes) {
    const name = `${rt.type} (${hostname})`;
    const result = await queries.runtime.upsertAgentRuntime(db, {
      workspaceId: mt.workspaceId,
      daemonId,
      name,
      runtimeMode: "local",
      provider: rt.type,
      deviceInfo: hostname,
      metadata: { version: rt.version },
    });
    results.push({ ...result, machineLastSeenAt: null });
  }

  await queries.machineToken.activateMachineToken(db, mt.id);

  // Notify the web UI
  try {
    await broadcastToUser(mt.userId, {
      type: "runtime.registered",
      daemonId,
      hostname,
      workspaceId: mt.workspaceId,
    });
  } catch (err) {
    log.warn("broadcast after activation failed", {
      userId: mt.userId,
      daemonId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return writeJSON({
    daemon_id: daemonId,
    runtimes: results.map(runtimeToResponse),
  });
}
