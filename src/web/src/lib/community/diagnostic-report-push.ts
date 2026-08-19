import { parseAttemptedCountReceipt } from "@alook/shared";
import type { DiagnosticCollectPayload } from "@alook/shared";
import { wsDoFetch } from "@/lib/broadcast";

export type DiagnosticDeliveryOutcome =
  | { kind: "attempted"; attempted: number }
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
    const attempted = parseAttemptedCountReceipt(await response.json(), {
      // A legacy sent-only ws-do predates deterministic deadline ownership,
      // so it cannot establish a safe offline/attempted result for new web.
      allowLegacySentOnly: false,
    });
    return attempted === 0
      ? { kind: "offline" }
      : { kind: "attempted", attempted };
  } catch {
    return { kind: "ambiguous" };
  }
}
