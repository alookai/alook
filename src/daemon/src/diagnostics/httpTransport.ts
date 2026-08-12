import { Readable } from "node:stream";
import type { DiagnosticReportFailureCode } from "@alook/shared";
import type { DiagnosticTransport, DiagnosticTransportResult } from "./types.js";

type TransportOutcome = DiagnosticTransportResult | { kind: "retryable" };

function endpoint(serverUrl: string, path: string): string {
  const base = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

async function strictOutcome(
  response: Response,
  allowed: Readonly<Record<string, number>>,
): Promise<TransportOutcome> {
  try {
    const value = await response.json() as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "retryable" };
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.kind !== "terminal") {
      return { kind: "retryable" };
    }
    const status = record.status;
    if ((status !== "uploaded" && status !== "failed") || allowed[status] !== response.status) {
      return { kind: "retryable" };
    }
    return { kind: "terminal", status };
  } catch {
    return { kind: "retryable" };
  }
}

export function createDiagnosticHttpTransport(args: {
  serverUrl: string;
  machineKey: string;
  fetchImpl?: typeof fetch;
}): DiagnosticTransport {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorization = `Bearer ${args.machineKey}`;

  return {
    async upload(meta, body: Readable): Promise<TransportOutcome> {
      try {
        const response = await fetchImpl(endpoint(
          args.serverUrl,
          `/api/community/daemon/diagnostics/${encodeURIComponent(meta.reportId)}/bundle`,
        ), {
          method: "PUT",
          headers: {
            authorization,
            "content-type": "application/x-ndjson",
            "content-encoding": "gzip",
            "content-length": String(meta.sizeBytes),
            "x-alook-content-sha256": meta.sha256,
          },
          body: Readable.toWeb(body),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        return strictOutcome(response, { uploaded: 200, failed: 409 });
      } catch {
        return { kind: "retryable" };
      }
    },

    async fail(reportId: string, failureCode: DiagnosticReportFailureCode): Promise<TransportOutcome> {
      try {
        const response = await fetchImpl(endpoint(
          args.serverUrl,
          `/api/community/daemon/diagnostics/${encodeURIComponent(reportId)}`,
        ), {
          method: "PATCH",
          headers: {
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: "failed", failureCode }),
        });
        return strictOutcome(response, { failed: 200 });
      } catch {
        return { kind: "retryable" };
      }
    },
  };
}
