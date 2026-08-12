import type { Readable } from "node:stream";
import type { DiagnosticCollectCommand, DiagnosticReportFailureCode } from "@alook/shared";

export type SnapshotSourceName = "daemon_log" | "fsm_trace";
export type SnapshotWarningCode =
  | "source_unavailable"
  | "malformed_json"
  | "line_too_long"
  | "incomplete_tail"
  | "invalid_timestamp";

export interface SnapshotRow {
  source: SnapshotSourceName;
  timeMs: number;
  ordinal: number;
  value: Record<string, unknown>;
}

export interface SnapshotReadResult {
  rows: SnapshotRow[];
  warnings: SnapshotWarningCode[];
  droppedRows: number;
}

export interface DiagnosticEventRow extends Record<string, unknown> {
  recordType: "daemon_log" | "fsm";
  timeMs: number;
}

export interface BundleArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  uncompressedBytes: number;
}

export interface DiagnosticTransportResult {
  kind: "terminal";
  status: "uploaded" | "failed";
}

export interface DiagnosticRetryResult {
  kind: "retryable";
}

export interface DiagnosticTransport {
  upload(meta: { reportId: string; sizeBytes: number; sha256: string }, body: Readable): Promise<DiagnosticTransportResult | DiagnosticRetryResult>;
  fail(reportId: string, failureCode: DiagnosticReportFailureCode): Promise<DiagnosticTransportResult | DiagnosticRetryResult>;
}

export interface DiagnosticCoordinatorResult {
  status: "uploaded" | "failed" | "pending" | "expired";
  failureCode?: DiagnosticReportFailureCode;
}

export interface DiagnosticBundleBuilder {
  (args: { command: DiagnosticCollectCommand; outputPath: string }): Promise<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
}
