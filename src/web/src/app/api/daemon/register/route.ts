import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, parseBody } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { RegisterDaemonRequestSchema, generateWorkspaceSlug } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, err] = await parseBody(req, RegisterDaemonRequestSchema);
  if (err) return err;

  const { daemon_id: daemonId, device_name: deviceName, cli_version: cliVersion, runtimes } = body;
  let workspaceId = body.workspace_id;

  // Resolve workspace: use provided, fall back to auth context, or create new
  if (!workspaceId && ctx.workspaceId) {
    workspaceId = ctx.workspaceId;
  }

  if (!workspaceId) {
    // Check if user already has a workspace before creating a new one
    const existing = await queries.workspace.listWorkspaces(db, ctx.userId);
    if (existing.length > 0) {
      workspaceId = existing[0].id;
    } else {
      const ws = await queries.workspace.createWorkspace(db, {
        name: "Personal",
        slug: generateWorkspaceSlug(),
      });
      await queries.member.createMember(db, {
        workspaceId: ws.id,
        userId: ctx.userId,
        role: "owner",
      });
      workspaceId = ws.id;
    }
  }

  // When authenticated with a machine token, enforce workspace match
  if (ctx.workspaceId && ctx.workspaceId !== workspaceId) {
    return writeJSON({ error: "workspace_id does not match token" }, 403);
  }

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
    const deviceInfo = deviceName.trim();
    const metadata: Record<string, unknown> = {
      version: rt.version || "",
      ...(cliVersion ? { cli_version: cliVersion } : {}),
    };

    const result = await queries.runtime.upsertAgentRuntime(db, {
      workspaceId,
      daemonId,
      runtimeMode,
      provider,
      deviceInfo,
      metadata,
    });
    results.push({ ...result, machineLastSeenAt: new Date().toISOString() });
  }

  await invalidate(cacheKeys.runtimeIds(workspaceId, daemonId));

  broadcastToUser(ctx.userId, {
    type: "runtime.registered",
    daemonId,
    hostname: deviceName.trim(),
    workspaceId,
  }).catch(() => {});

  return writeJSON({ runtimes: results.map(runtimeToResponse), workspaceId });
});
