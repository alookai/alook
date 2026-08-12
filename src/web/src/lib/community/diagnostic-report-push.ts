import type { DiagnosticCollectPayload } from "@alook/shared";
import { wsDoFetch } from "@/lib/broadcast";

export type DiagnosticDeliveryOutcome =
  | { kind: "delivered"; sent: number }
  | { kind: "offline" }
  | { kind: "ambiguous" };

export async function pushDiagnosticReportToMachine(
  env: Env,
  machineId: string,
  payload: DiagnosticCollectPayload,
): Promise<DiagnosticDeliveryOutcome> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-diagnostics-collect`;
  try {
    const response = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { label: machineId, type: "diagnostics:collect" },
    );
    if (!response.ok) return { kind: "ambiguous" };
    const result = await response.json() as { sent?: unknown };
    if (!Number.isSafeInteger(result.sent) || (result.sent as number) < 0) {
      return { kind: "ambiguous" };
    }
    return (result.sent as number) === 0
      ? { kind: "offline" }
      : { kind: "delivered", sent: result.sent as number };
  } catch {
    return { kind: "ambiguous" };
  }
}
