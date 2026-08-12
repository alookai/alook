import {
  createDb,
  DiagnosticCollectCommandSchema,
  DiagnosticCollectPayloadSchema,
  queries,
} from "@alook/shared";
import type { RouterContext } from "../router-context";

export async function handleMachineDiagnostics(
  { request, env, url, traceId, log }: RouterContext,
): Promise<Response | null> {
  const match = url.pathname.match(
    /^\/community-machine\/by-id\/([^/]+)\/forward-diagnostics-collect$/,
  );
  if (!match || request.method !== "POST") return null;

  const machineId = decodeURIComponent(match[1]);
  const reqLog = log.child({ traceId, machineId });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }
  const payload = DiagnosticCollectPayloadSchema.safeParse(raw);
  if (!payload.success) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }
  const command = DiagnosticCollectCommandSchema.safeParse({
    type: "diagnostics:collect",
    ...payload.data,
  });
  if (!command.success) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  let doNames: string[];
  try {
    const db = createDb((env as unknown as { DB: D1Database }).DB);
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId);
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for diagnostics", { err });
    return Response.json({ error: "failed to resolve machine" }, { status: 503 });
  }
  if (doNames.length === 0) return Response.json({ sent: 0 });

  const body = JSON.stringify(command.data);
  let delivered = 0;
  let ambiguous = false;
  for (const doName of doNames) {
    const id = env.WS_DO.idFromName(`community-machine:${doName}`);
    const stub = env.WS_DO.get(id);
    try {
      const response = await stub.fetch(new Request(
        "http://internal/forward-diagnostics-collect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      ));
      if (!response.ok) {
        ambiguous = true;
        continue;
      }
      const result = await response.json() as { sent?: unknown };
      if (!Number.isSafeInteger(result.sent) || (result.sent as number) < 0) {
        ambiguous = true;
        continue;
      }
      delivered += result.sent as number;
    } catch {
      ambiguous = true;
    }
  }

  if (delivered === 0 && ambiguous) {
    return Response.json({ error: "diagnostic delivery ambiguous" }, { status: 503 });
  }
  return Response.json({ sent: delivered });
}
