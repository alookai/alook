import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, createLogger, BindWorkspaceRequestSchema } from "@alook/shared";
import { getDb, withD1Retry } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { broadcastToUser, broadcastToDaemon } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

const log = createLogger({ service: "machine-tokens/bind-workspace" });

export const POST = withAuth(async (req: NextRequest, ctx) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return writeJSON({ error: "invalid request body" }, 400);
  }

  const parsed = BindWorkspaceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return writeJSON({ error: "invalid payload", details: parsed.error.flatten() }, 400);
  }

  const { workspace_id: workspaceId } = parsed.data;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const token = await withD1Retry(() =>
    queries.machineToken.getRegisteredTokenForUser(db, ctx.userId)
  );
  if (!token) {
    const latest = await withD1Retry(() =>
      queries.machineToken.getLatestTokenForUser(db, ctx.userId)
    );
    if (latest) {
      return writeJSON(
        { error: `token exists but status is "${latest.status}", expected "registered"` },
        409,
      );
    }
    return writeJSON({ error: "no registered token found" }, 404);
  }

  const membership = await withD1Retry(() =>
    queries.member.getMemberByUserAndWorkspace(db, ctx.userId, workspaceId)
  );
  if (!membership) {
    return writeJSON({ error: "not a member of this workspace" }, 403);
  }

  await withD1Retry(() =>
    queries.machineToken.activateMachineToken(db, token.id, workspaceId)
  );

  const hostname = token.hostname || "unknown";
  const daemonId = hostname;

  await withD1Retry(() =>
    queries.machine.upsertMachine(db, {
      daemonId,
      workspaceId,
      deviceInfo: hostname,
      lastSeenAt: null,
    })
  );

  let runtimesData: Array<{ type: string; version?: string }> = [];
  try {
    runtimesData = token.runtimesJson ? JSON.parse(token.runtimesJson) : [];
  } catch {
    return writeJSON({ error: "corrupt runtimes data on token" }, 422);
  }

  const results = [];
  for (const rt of runtimesData) {
    const result = await withD1Retry(() =>
      queries.runtime.upsertAgentRuntime(db, {
        workspaceId,
        daemonId,
        runtimeMode: "local",
        provider: rt.type,
        deviceInfo: hostname,
        metadata: { version: rt.version || "" },
      })
    );
    results.push({ ...result, machineLastSeenAt: null });
  }

  await Promise.all([
    invalidate(cacheKeys.machineToken(token.token)),
    invalidate(cacheKeys.runtimeIds(workspaceId, daemonId)),
    invalidate(cacheKeys.allRuntimes(workspaceId)),
  ]);

  broadcastToUser(ctx.userId, {
    type: "runtime.registered",
    daemonId,
    hostname,
    workspaceId,
  }).catch((err) => {
    log.warn("broadcast after bind failed", {
      userId: ctx.userId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  const ws = await withD1Retry(() =>
    queries.workspace.getWorkspace(db, workspaceId, ctx.userId)
  );

  broadcastToDaemon(daemonId, {
    type: "daemon.workspace_added",
    workspaceId,
    workspaceName: ws?.name || "Personal",
    token: token.token,
  }).catch((err) => {
    log.warn("daemon push after bind failed", {
      daemonId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return writeJSON({
    workspace_id: workspaceId,
    runtimes: results.map(runtimeToResponse),
  });
});
