import { createHash } from "node:crypto";
import {
  queries,
  withD1Retry,
  type Database,
  type DiagnosticReportFailureCode,
} from "@alook/shared";

type ReportRow = {
  id: string;
  ownerUserId: string;
  machineId: string;
  status: "pending" | "uploaded" | "failed";
  deadlineAt: number;
  failureCode: string | null;
  r2Key: string | null;
  sha256: string | null;
  sizeBytes: number | null;
};

export type DiagnosticUploadResult =
  | { kind: "terminal"; status: "uploaded" | "failed" }
  | { kind: "retryable" }
  | { kind: "rejected"; status: 400 | 404 | 409 };

export interface DiagnosticUploadQueryPort {
  getPending(input: { reportId: string; machineId: string; nowMs: number }): Promise<ReportRow | null>;
  get(input: { reportId: string; machineId: string }): Promise<ReportRow | null>;
  finalize(input: {
    reportId: string;
    machineId: string;
    r2Key: string;
    sha256: string;
    sizeBytes: number;
    nowMs: number;
  }): Promise<ReportRow | null>;
  fail(input: {
    reportId: string;
    machineId: string;
    failureCode: DiagnosticReportFailureCode;
    nowMs: number;
  }): Promise<ReportRow | null>;
  timeout(input: { reportId: string; ownerUserId: string; nowMs: number }): Promise<ReportRow | null>;
}

interface R2Port {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: R2PutOptions,
  ): Promise<R2Object | object | null>;
  head(key: string): Promise<Pick<R2Object, "size" | "checksums"> | null>;
  delete(key: string): Promise<void>;
}

type FixedLengthFactory = (sizeBytes: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function exactSha256Bytes(hex: string): ArrayBuffer | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value || value.byteLength !== 32) return null;
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uploadedSame(
  row: ReportRow,
  expected: { r2Key: string; sha256: string; sizeBytes: number },
): boolean {
  return row.status === "uploaded"
    && row.r2Key === expected.r2Key
    && row.sha256 === expected.sha256
    && row.sizeBytes === expected.sizeBytes;
}

export function createDiagnosticUploadQueryPort(db: Database): DiagnosticUploadQueryPort {
  const q = queries.communityDiagnosticReport;
  return {
    getPending: (input) => withD1Retry(
      () => q.getPendingDiagnosticReportForMachine(db, input),
      { route: "community/diagnostics-upload:get-pending" },
    ),
    get: (input) => withD1Retry(
      () => q.getDiagnosticReportForMachine(db, input),
      { route: "community/diagnostics-upload:get" },
    ),
    finalize: (input) => withD1Retry(
      () => q.finalizeDiagnosticReportUpload(db, input),
      { route: "community/diagnostics-upload:finalize" },
    ),
    fail: (input) => withD1Retry(
      () => q.failPendingDiagnosticReport(db, input),
      { route: "community/diagnostics-upload:fail" },
    ),
    timeout: (input) => withD1Retry(
      () => q.timeoutPendingDiagnosticReport(db, input),
      { route: "community/diagnostics-upload:timeout" },
    ),
  };
}

export function createDiagnosticUploadService(args: {
  bucket: R2Port;
  queries: DiagnosticUploadQueryPort;
  now?: () => number;
  fixedLengthStream?: FixedLengthFactory;
}) {
  const now = args.now ?? Date.now;
  const fixedLengthStream: FixedLengthFactory = args.fixedLengthStream
    ?? ((sizeBytes) => new FixedLengthStream(sizeBytes));

  const convergeFailure = async (input: {
    reportId: string;
    machineId: string;
    failureCode: DiagnosticReportFailureCode;
    nowMs: number;
  }): Promise<DiagnosticUploadResult> => {
    let failed: ReportRow | null;
    try {
      failed = await args.queries.fail(input);
    } catch {
      return { kind: "retryable" };
    }
    if (failed) return { kind: "terminal", status: "failed" };
    let authoritative: ReportRow | null;
    try {
      authoritative = await args.queries.get({
        reportId: input.reportId,
        machineId: input.machineId,
      });
    } catch {
      return { kind: "retryable" };
    }
    if (!authoritative) return { kind: "rejected", status: 404 };
    if (authoritative.status === "pending") return { kind: "retryable" };
    if (authoritative.status === "failed" && authoritative.failureCode === input.failureCode) {
      return { kind: "terminal", status: "failed" };
    }
    return { kind: "rejected", status: 409 };
  };

  const deleteCreatedObject = async (key: string): Promise<void> => {
    try {
      await args.bucket.delete(key);
    } catch {
      // The database terminal is authoritative. The private bucket's lifecycle
      // remains the bounded cleanup fallback when best-effort deletion fails.
    }
  };

  const compensateFinalize = async (input: {
    report: ReportRow;
    reportId: string;
    machineId: string;
    r2Key: string;
    sha256: string;
    sizeBytes: number;
    nowMs: number;
    createdByThisRequest: boolean;
  }): Promise<DiagnosticUploadResult> => {
    let authoritative: ReportRow | null;
    try {
      authoritative = await args.queries.get({ reportId: input.reportId, machineId: input.machineId });
    } catch {
      return { kind: "retryable" };
    }
    if (!authoritative) return { kind: "retryable" };
    const expected = { r2Key: input.r2Key, sha256: input.sha256, sizeBytes: input.sizeBytes };
    if (uploadedSame(authoritative, expected)) return { kind: "terminal", status: "uploaded" };
    if (authoritative.status === "uploaded") return { kind: "terminal", status: "failed" };
    if (authoritative.status === "failed") {
      if (input.createdByThisRequest) await deleteCreatedObject(input.r2Key);
      return { kind: "terminal", status: "failed" };
    }
    if (authoritative.deadlineAt > input.nowMs) return { kind: "retryable" };

    let timedOut: ReportRow | null;
    try {
      timedOut = await args.queries.timeout({
        reportId: input.reportId,
        ownerUserId: input.report.ownerUserId,
        nowMs: input.nowMs,
      });
    } catch {
      return { kind: "retryable" };
    }
    if (!timedOut) return { kind: "retryable" };
    if (timedOut.status === "failed") {
      if (input.createdByThisRequest) await deleteCreatedObject(input.r2Key);
      return { kind: "terminal", status: "failed" };
    }
    if (uploadedSame(timedOut, expected)) return { kind: "terminal", status: "uploaded" };
    return { kind: "retryable" };
  };

  return {
    async upload(input: {
      reportId: string;
      machineId: string;
      sizeBytes: number;
      sha256: string;
      body: ReadableStream<Uint8Array>;
    }): Promise<DiagnosticUploadResult> {
      const sha256Bytes = exactSha256Bytes(input.sha256);
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 10 * 1024 * 1024 || !sha256Bytes) {
        return { kind: "rejected", status: 400 };
      }
      const nowMs = now();
      let report: ReportRow | null;
      try {
        report = await args.queries.getPending({
          reportId: input.reportId,
          machineId: input.machineId,
          nowMs,
        });
      } catch {
        return { kind: "retryable" };
      }
      if (!report) {
        let authoritative: ReportRow | null;
        try {
          authoritative = await args.queries.get({ reportId: input.reportId, machineId: input.machineId });
        } catch {
          return { kind: "retryable" };
        }
        if (!authoritative) return { kind: "rejected", status: 404 };
        if (uploadedSame(authoritative, {
          r2Key: `bug-reports/${authoritative.ownerUserId}/${input.reportId}.ndjson.gz`,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
        })) return { kind: "terminal", status: "uploaded" };
        if (authoritative.status === "failed") return { kind: "terminal", status: "failed" };
        return { kind: "rejected", status: 409 };
      }

      const r2Key = `bug-reports/${report.ownerUserId}/${input.reportId}.ndjson.gz`;
      const fixed = fixedLengthStream(input.sizeBytes);
      const writer = fixed.writable.getWriter();
      const reader = input.body.getReader();
      const hash = createHash("sha256");
      let seen = 0;
      let localInvalid = false;
      let destinationFailed = false;
      let destinationDetached = false;
      let pumpFinished = false;

      const pump = (async () => {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            seen += next.value.byteLength;
            if (seen > input.sizeBytes) {
              localInvalid = true;
              await reader.cancel().catch(() => {});
              break;
            }
            hash.update(next.value);
            if (!destinationFailed && !destinationDetached) {
              try {
                await writer.write(next.value);
              } catch {
                if (!destinationDetached) destinationFailed = true;
              }
            }
          }
          if (!localInvalid && (seen !== input.sizeBytes || hash.digest("hex") !== input.sha256)) {
            localInvalid = true;
          }
        } catch {
          localInvalid = true;
        }

        try {
          if (destinationDetached) {
            // The destination settled before source validation completed. Its
            // settlement handler already released the writer.
          } else if (localInvalid || destinationFailed) {
            try {
              await writer.abort();
            } catch {
              destinationFailed = true;
            }
          } else {
            try {
              await writer.close();
            } catch {
              destinationFailed = true;
            }
          }
        } finally {
          pumpFinished = true;
        }
      })();

      const put = Promise.resolve(args.bucket.put(r2Key, fixed.readable, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: sha256Bytes,
        storageClass: "Standard",
        httpMetadata: {
          contentType: "application/x-ndjson",
          contentEncoding: "gzip",
        },
      })).then(async (result) => {
        if (!pumpFinished) {
          destinationDetached = true;
          try {
            await writer.abort();
          } catch {
            destinationFailed = true;
          }
        }
        return result;
      }, async (error) => {
        destinationDetached = true;
        try {
          await writer.abort(error);
        } catch {
          destinationFailed = true;
        }
        throw error;
      });

      const [pumpResult, putResult] = await Promise.allSettled([pump, put]);
      if (localInvalid) {
        return convergeFailure({
          reportId: input.reportId,
          machineId: input.machineId,
          failureCode: "invalid_upload",
          nowMs,
        });
      }
      if (pumpResult.status === "rejected" || putResult.status === "rejected") {
        return { kind: "retryable" };
      }

      const createdByThisRequest = putResult.value !== null;
      if (createdByThisRequest && destinationFailed) return { kind: "retryable" };
      if (!createdByThisRequest) {
        let head: Awaited<ReturnType<R2Port["head"]>>;
        try {
          head = await args.bucket.head(r2Key);
        } catch {
          return { kind: "retryable" };
        }
        if (!head || head.size !== input.sizeBytes || checksumHex(head.checksums?.sha256) !== input.sha256) {
          return convergeFailure({
            reportId: input.reportId,
            machineId: input.machineId,
            failureCode: "upload_conflict",
            nowMs,
          });
        }
      }

      let finalized: ReportRow | null;
      try {
        finalized = await args.queries.finalize({
          reportId: input.reportId,
          machineId: input.machineId,
          r2Key,
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
          nowMs,
        });
      } catch {
        return { kind: "retryable" };
      }
      if (finalized) return { kind: "terminal", status: "uploaded" };
      return compensateFinalize({
        report,
        reportId: input.reportId,
        machineId: input.machineId,
        r2Key,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        nowMs,
        createdByThisRequest,
      });
    },

    async fail(input: {
      reportId: string;
      machineId: string;
      failureCode: DiagnosticReportFailureCode;
    }): Promise<DiagnosticUploadResult> {
      try {
        return await convergeFailure({ ...input, nowMs: now() });
      } catch {
        return { kind: "retryable" };
      }
    },
  };
}
