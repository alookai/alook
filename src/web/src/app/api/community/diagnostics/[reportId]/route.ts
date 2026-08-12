import {
  DiagnosticReportIdSchema,
  queries,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { projectOwnerDiagnosticReport } from "@/lib/community/diagnostic-report";
import { withAuth } from "@/lib/middleware/auth";
import { writeError, writeJSON } from "@/lib/middleware/helpers";

export const GET = withAuth(async (_req, ctx) => {
  const parsedId = DiagnosticReportIdSchema.safeParse(ctx.params?.reportId);
  if (!parsedId.success) return writeError("invalid diagnostic report id", 400);

  const db = getDb(ctx.env.DB);
  const ownerInput = { reportId: parsedId.data, ownerUserId: ctx.userId };
  let report = await queries.communityDiagnosticReport.getDiagnosticReportForOwner(db, ownerInput);
  if (!report) return writeError("diagnostic report not found", 404);

  const nowMs = Date.now();
  if (report.status === "pending" && report.deadlineAt <= nowMs) {
    const timedOut = await queries.communityDiagnosticReport.timeoutPendingDiagnosticReport(db, {
      ...ownerInput,
      nowMs,
    });
    report = timedOut ?? await queries.communityDiagnosticReport.getDiagnosticReportForOwner(
      db,
      ownerInput,
    );
    if (!report) return writeError("diagnostic report not found", 404);
  }

  return writeJSON({ report: projectOwnerDiagnosticReport(report, nowMs) });
});
