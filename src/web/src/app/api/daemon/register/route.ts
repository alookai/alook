import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, parseBody } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { RegisterDaemonRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, err] = await parseBody(req, RegisterDaemonRequestSchema);
  if (err) return err;

  const { workspace_id: workspaceId, daemon_id: daemonId, device_name: deviceName, cli_version: cliVersion, runtimes } = body;

  const membership = await queries.member.getMemberByUserAndWorkspace(
    db,
    ctx.userId,
    workspaceId
  );
  if (!membership) {
    return writeJSON({ error: "workspace not found" }, 404);
  }

  // Upsert machine row (1 write for liveness)
  await queries.machine.upsertMachine(db, {
    daemonId,
    workspaceId,
    deviceInfo: deviceName.trim(),
  });

  const results = [];
  for (const rt of runtimes) {
    const provider = (rt.type || rt.provider || "unknown").trim();
    const runtimeMode = rt.runtime_mode || "local";
    let name = (rt.name || "").trim();
    if (!name) {
      name = deviceName ? `${provider} (${deviceName})` : provider;
    }
    const deviceInfo = deviceName.trim();
    const metadata: Record<string, unknown> = {
      version: rt.version || "",
      cli_version: cliVersion,
    };

    const result = await queries.runtime.upsertAgentRuntime(db, {
      workspaceId,
      daemonId,
      name,
      runtimeMode,
      provider,
      deviceInfo,
      metadata,
    });
    results.push({ ...result, machineLastSeenAt: new Date().toISOString() });
  }

  broadcastToUser(ctx.userId, {
    type: "runtime.registered",
    daemonId,
    hostname: deviceName.trim(),
    workspaceId,
  }).catch(() => {});

  return writeJSON({ runtimes: results.map(runtimeToResponse) });
});
