import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, semverGte } from "@alook/shared"
import { getDb, withD1Retry } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, parseBody } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { RegisterDaemonRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, err] = await parseBody(req, RegisterDaemonRequestSchema);
  if (err) return err;

  const { daemon_id: daemonId, device_name: deviceName, cli_version: cliVersion, workspaces_root: workspacesRoot, runtimes } = body;
  let workspaceId = body.workspace_id;

  // Resolve workspace: use provided or fall back to auth context
  if (!workspaceId && ctx.workspaceId) {
    workspaceId = ctx.workspaceId;
  }

  if (!workspaceId) {
    return writeJSON({ error: "workspace_id is required" }, 400);
  }

  // When authenticated with a machine token, enforce workspace match
  if (ctx.workspaceId && ctx.workspaceId !== workspaceId) {
    return writeJSON({ error: "workspace_id does not match token" }, 403);
  }

  const membership = await withD1Retry(() => queries.member.getMemberByUserAndWorkspace(
    db,
    ctx.userId,
    workspaceId
  ));
  if (!membership) {
    return writeJSON({ error: "workspace not found" }, 404);
  }

  // Upsert machine row (1 write for liveness) — non-critical
  try {
    await queries.machine.upsertMachine(db, {
      daemonId,
      workspaceId,
      deviceInfo: deviceName.trim(),
    });
  } catch (e) {
    log.warn("register: machine upsert failed", { daemonId, err: String(e) });
  }

  // Clear pendingUpdateVersion if daemon re-registered with a satisfying version
  if (cliVersion) {
    try {
      const machineRow = await queries.machine.getMachineByDaemon(db, daemonId, workspaceId);
      if (machineRow?.pendingUpdateVersion && semverGte(cliVersion, machineRow.pendingUpdateVersion)) {
        await queries.machine.clearPendingUpdateVersion(db, daemonId, workspaceId);
        broadcastToUser(ctx.userId, {
          type: "runtime.status",
          daemonId,
          workspaceId,
          status: "online",
        }).catch(() => {});
      }
    } catch (e) {
      log.warn("register: pending version check failed", { daemonId, err: String(e) });
    }
  }

  const results = [];
  for (const rt of runtimes) {
    const provider = (rt.type || rt.provider || "unknown").trim();
    const runtimeMode = rt.runtime_mode || "local";
    const deviceInfo = deviceName.trim();
    const metadata: Record<string, unknown> = {
      version: rt.version || "",
      ...(cliVersion ? { cli_version: cliVersion } : {}),
      ...(workspacesRoot ? { workspaces_root: workspacesRoot } : {}),
    };

    const result = await withD1Retry(() => queries.runtime.upsertAgentRuntime(db, {
      workspaceId,
      daemonId,
      runtimeMode,
      provider,
      deviceInfo,
      metadata,
    }));
    results.push({ ...result, machineLastSeenAt: new Date().toISOString() });
  }

  await Promise.all([
    invalidate(cacheKeys.runtimeIds(workspaceId, daemonId)),
    invalidate(cacheKeys.allRuntimes(workspaceId)),
  ]);

  broadcastToUser(ctx.userId, {
    type: "runtime.registered",
    daemonId,
    hostname: deviceName.trim(),
    workspaceId,
  }).catch(() => {});

  return writeJSON({ runtimes: results.map(runtimeToResponse), workspaceId });
});
