import { NextResponse } from "next/server";
import {
  DiagnosticReportIdSchema,
  type DiagnosticReportFailureCode,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth";
import {
  createDiagnosticUploadQueryPort,
  createDiagnosticUploadService,
  type DiagnosticUploadResult,
} from "@/lib/community/diagnostic-upload";

const DAEMON_FAILURE_CODES = new Set<DiagnosticReportFailureCode>([
  "diagnostics_unavailable",
  "collector_busy",
  "bot_not_bound",
  "collection_failed",
  "local_artifact_invalid",
  "bundle_too_large",
  "upload_failed",
]);

function responseStatus(result: DiagnosticUploadResult): number {
  if (result.kind === "retryable") return 503;
  if (result.kind === "rejected") return result.status;
  return result.status === "failed" ? 200 : 409;
}

function parseFailure(value: unknown): DiagnosticReportFailureCode | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || body.status !== "failed" || typeof body.failureCode !== "string") {
    return null;
  }
  return DAEMON_FAILURE_CODES.has(body.failureCode as DiagnosticReportFailureCode)
    ? body.failureCode as DiagnosticReportFailureCode
    : null;
}

export const PATCH = withCommunityDaemonAuth(async (request, ctx) => {
  const parsedReportId = DiagnosticReportIdSchema.safeParse(ctx.params?.reportId);
  if (!parsedReportId.success) {
    return NextResponse.json({ error: "invalid diagnostic report id" }, { status: 400 });
  }
  const reportId = parsedReportId.data;
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid diagnostic failure body" }, { status: 400 });
  }
  const failureCode = parseFailure(value);
  if (!failureCode) {
    return NextResponse.json({ error: "invalid diagnostic failure body" }, { status: 400 });
  }

  const db = getDb(ctx.env.DB);
  const service = createDiagnosticUploadService({
    bucket: ctx.env.BUG_REPORTS,
    queries: createDiagnosticUploadQueryPort(db),
  });
  const result = await service.fail({
    reportId,
    machineId: ctx.machineId,
    failureCode,
  });
  return NextResponse.json(result, { status: responseStatus(result) });
});
