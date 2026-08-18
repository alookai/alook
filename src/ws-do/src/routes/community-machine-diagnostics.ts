import {
  createDb,
  DiagnosticCollectCommandSchema,
  DiagnosticCollectPayloadSchema,
  parseAttemptedCountReceipt,
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

  // Deadline ownership is deterministic by machineId, independent of the
  // currently active credential doName. Register before D1 lookup/fanout so
  // lookup failures, credential rotation, and ambiguous socket writes cannot
  // strand the durable report row forever.
  try {
    const deadlineId = env.WS_DO.idFromName(`community-machine-deadline:${machineId}`);
    const deadlineStub = env.WS_DO.get(deadlineId);
    const registration = await deadlineStub.fetch(new Request(
      `http://internal/register-diagnostic-deadline?machineId=${encodeURIComponent(machineId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadlineAt: command.data.deadlineAt }),
      },
    ));
    if (!registration.ok) {
      return Response.json({ error: "diagnostic deadline registration failed" }, { status: 503 });
    }
    const receipt = await registration.json() as unknown;
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Object.keys(receipt).length !== 1 ||
      (receipt as Record<string, unknown>).registered !== true
    ) {
      return Response.json({ error: "diagnostic deadline registration failed" }, { status: 503 });
    }
  } catch (err) {
    reqLog.error("failed to register diagnostic deadline", { err });
    return Response.json({ error: "diagnostic deadline registration failed" }, { status: 503 });
  }

  let doNames: string[];
  try {
    const db = createDb((env as unknown as { DB: D1Database }).DB);
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId);
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for diagnostics", { err });
    return Response.json({ error: "failed to resolve machine" }, { status: 503 });
  }
  if (doNames.length === 0) return Response.json({ attempted: 0, sent: 0 });

  const body = JSON.stringify(command.data);
  let attempted = 0;
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
      attempted += parseAttemptedCountReceipt(await response.json());
    } catch {
      ambiguous = true;
    }
  }

  if (ambiguous) {
    return Response.json({ error: "diagnostic delivery ambiguous" }, { status: 503 });
  }
  return Response.json({ attempted, sent: attempted });
}
