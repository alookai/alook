import { NextResponse } from "next/server";
import { DiagnosticReportIdSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth";
import {
  createDiagnosticUploadQueryPort,
  createDiagnosticUploadService,
  type DiagnosticUploadResult,
} from "@/lib/community/diagnostic-upload";

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

function responseStatus(result: DiagnosticUploadResult): number {
  if (result.kind === "retryable") return 503;
  if (result.kind === "rejected") return result.status;
  return result.status === "uploaded" ? 200 : 409;
}

export const PUT = withCommunityDaemonAuth(async (request, ctx) => {
  const parsedReportId = DiagnosticReportIdSchema.safeParse(ctx.params?.reportId);
  if (!parsedReportId.success) {
    return NextResponse.json({ error: "invalid diagnostic report id" }, { status: 400 });
  }
  const reportId = parsedReportId.data;
  if (request.headers.get("content-type") !== "application/x-ndjson"
    || request.headers.get("content-encoding") !== "gzip") {
    return NextResponse.json({ error: "invalid diagnostic content headers" }, { status: 400 });
  }
  const rawLength = request.headers.get("content-length");
  if (!rawLength || !/^[1-9][0-9]*$/.test(rawLength)) {
    return NextResponse.json({ error: "invalid diagnostic content length" }, { status: 400 });
  }
  const sizeBytes = Number(rawLength);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > MAX_BUNDLE_BYTES) {
    return NextResponse.json({ error: "invalid diagnostic content length" }, { status: 400 });
  }
  const sha256 = request.headers.get("x-alook-content-sha256");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || request.body === null) {
    return NextResponse.json({ error: "invalid diagnostic upload" }, { status: 400 });
  }

  const db = getDb(ctx.env.DB);
  const service = createDiagnosticUploadService({
    bucket: ctx.env.BUG_REPORTS,
    queries: createDiagnosticUploadQueryPort(db),
  });
  const result = await service.upload({
    reportId,
    machineId: ctx.machineId,
    sizeBytes,
    sha256,
    body: request.body,
  });
  return NextResponse.json(result, { status: responseStatus(result) });
});
