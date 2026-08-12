import { NextRequest } from "next/server";
import {
  DiagnosticReportCreateRequestSchema,
  queries,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { pushDiagnosticReportToMachine } from "@/lib/community/diagnostic-report-push";
import {
  projectOwnerDiagnosticReport,
  type OwnerDiagnosticReportSource,
} from "@/lib/community/diagnostic-report";
import { withAuth } from "@/lib/middleware/auth";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";

function reportEnvelope(
  delivery: "accepted" | "unknown",
  report: OwnerDiagnosticReportSource,
  nowMs: number,
  status: number,
) {
  return writeJSON({
    delivery,
    report: projectOwnerDiagnosticReport(report, nowMs),
  }, status);
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const [body, bodyError] = await parseBody(req, DiagnosticReportCreateRequestSchema);
  if (bodyError) return bodyError;
  const agentId = ctx.params?.id as string;
  const nowMs = Date.now();
  const db = getDb(ctx.env.DB);

  let result: Awaited<ReturnType<
    typeof queries.communityDiagnosticReport.createOrGetPendingDiagnosticReport
  >>;
  try {
    result = await queries.communityDiagnosticReport.createOrGetPendingDiagnosticReport(db, {
      ownerUserId: ctx.userId,
      agentId,
      clientNonce: body.clientNonce,
      nowMs,
    });
  } catch (error) {
    if (error instanceof queries.communityDiagnosticReport.DiagnosticReportTargetUnavailableError) {
      return writeError("diagnostic target unavailable", 404);
    }
    throw error;
  }

  const report = result.report;
  if (result.kind === "rate_limited") {
    return writeError("diagnostic report rate limited", 429);
  }
  if (result.kind === "same_nonce" && report.agentId !== agentId) {
    return writeError("diagnostic nonce belongs to another bot", 409);
  }
  if (report.status !== "pending") {
    return reportEnvelope("accepted", report, nowMs, 200);
  }
  if (result.kind === "existing_pending") {
    return reportEnvelope("accepted", report, nowMs, 202);
  }

  const delivery = await pushDiagnosticReportToMachine(ctx.env, report.machineId, {
    reportId: report.id,
    agentId: report.agentId,
    fromMs: report.fromMs,
    deadlineAt: report.deadlineAt,
  });
  if (delivery.kind === "delivered") {
    return reportEnvelope("accepted", report, nowMs, 202);
  }
  if (delivery.kind === "ambiguous") {
    return reportEnvelope("unknown", report, nowMs, 202);
  }

  const failed = await queries.communityDiagnosticReport.failPendingDiagnosticReport(db, {
    reportId: report.id,
    machineId: report.machineId,
    failureCode: "offline",
    nowMs,
  });
  if (failed) {
    return reportEnvelope("accepted", failed, nowMs, 200);
  }

  const authoritative = await queries.communityDiagnosticReport.getDiagnosticReportForOwner(db, {
    reportId: report.id,
    ownerUserId: ctx.userId,
  });
  if (!authoritative) return writeError("diagnostic report not found", 404);
  return authoritative.status === "pending"
    ? reportEnvelope("unknown", authoritative, nowMs, 202)
    : reportEnvelope("accepted", authoritative, nowMs, 200);
});
