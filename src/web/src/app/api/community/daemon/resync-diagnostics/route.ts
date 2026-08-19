import { NextResponse } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { pushDiagnosticReportToMachine } from "@/lib/community/diagnostic-report-push";
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth";

export const POST = withCommunityDaemonAuth(async (_request, ctx) => {
  const db = getDb(ctx.env.DB);
  const nowMs = Date.now();
  await queries.communityDiagnosticReport.timeoutPendingDiagnosticReportsForMachine(db, {
    machineId: ctx.machineId,
    nowMs,
  });
  const reports = await queries.communityDiagnosticReport.listPendingDiagnosticReportsForMachine(db, {
    machineId: ctx.machineId,
    nowMs,
  });

  let attempted = 0;
  let ambiguous = 0;
  for (const report of reports) {
    const outcome = await pushDiagnosticReportToMachine(ctx.env, ctx.machineId, {
      reportId: report.id,
      agentId: report.agentId,
      fromMs: report.fromMs,
      deadlineAt: report.deadlineAt,
    });
    if (outcome.kind === "attempted") attempted++;
    else if (outcome.kind === "ambiguous") ambiguous++;
  }

  return NextResponse.json({ pending: reports.length, attempted, ambiguous });
});
