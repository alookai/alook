import {
  OwnerDiagnosticReportSchema,
  type DiagnosticReportFailureCode,
  type OwnerDiagnosticReport,
} from "@alook/shared";

export type OwnerDiagnosticReportSource = Readonly<{
  id: string;
  status: "pending" | "uploaded" | "failed";
  failureCode: DiagnosticReportFailureCode | null;
  deadlineAt: number;
  completedAt: number | null;
  objectExpiresAt: number | null;
}>;

/** Project a private D1 report row onto the exact owner-safe wire contract. */
export function projectOwnerDiagnosticReport(
  report: OwnerDiagnosticReportSource,
  nowMs: number,
): OwnerDiagnosticReport {
  return OwnerDiagnosticReportSchema.parse({
    reportId: report.id,
    status: report.status,
    deadlineAt: report.deadlineAt,
    completedAt: report.completedAt,
    failureCode: report.failureCode,
    objectExpired:
      report.status === "uploaded" &&
      report.objectExpiresAt !== null &&
      report.objectExpiresAt <= nowMs,
  });
}
