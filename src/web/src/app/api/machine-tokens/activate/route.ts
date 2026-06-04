import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, ActivateTokenRequestSchema, createLogger } from "@alook/shared";
import { getDb } from "@/lib/db"
import { writeJSON } from "@/lib/middleware/helpers";
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

  await queries.machineToken.registerMachineToken(
    db,
    mt.id,
    hostname,
    JSON.stringify(runtimes),
  );

  await invalidate(cacheKeys.machineToken(token));

  broadcastToUser(mt.userId, {
    type: "machine.registered",
    daemonId: hostname,
    hostname,
  }).catch((err) => {
    log.warn("broadcast after registration failed", {
      userId: mt.userId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return writeJSON({
    daemon_id: hostname,
    token_status: "registered",
  });
}
