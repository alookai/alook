import { describe, expect, expectTypeOf, it } from "vitest";
import * as Shared from "../src/index";
import { HostCommandSchema } from "../src/community-cli-contract";
import { DIAGNOSTIC_REPORT_FAILURE_CODES as DB_FAILURE_CODES } from "../src/db/community-machine-schema";
import {
  DIAGNOSTIC_COLLECT_SPAN_MS,
  DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS,
  DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS,
  DIAGNOSTIC_REPORT_FAILURE_CODES,
  DiagnosticCollectCommandSchema,
  DiagnosticCollectPayloadSchema,
  DiagnosticReportFailureCodeSchema,
  DiagnosticReportCreateRequestSchema,
  DiagnosticReportIdSchema,
  OwnerDiagnosticReportSchema,
} from "../src/diagnostics-contract";
import type { DiagnosticReportFailureCode } from "../src/diagnostics-contract";
import type { DiagnosticReportFailureCode as BarrelDiagnosticReportFailureCode } from "../src/index";

const FROM_MS = 1_700_000_000_000;
const DEADLINE_AT = FROM_MS + DIAGNOSTIC_COLLECT_SPAN_MS;
const NONCE = "nonce_1234567890";

const valid = {
  type: "diagnostics:collect",
  reportId: "dbr_0123456789abcdef",
  agentId: "bot_1",
  fromMs: FROM_MS,
  deadlineAt: DEADLINE_AT,
} as const;

describe("shared diagnostics contract ownership", () => {
  it("exports one frozen set of collection and deadline constants", () => {
    expect(DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS).toBe(86_400_000);
    expect(DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS).toBe(600_000);
    expect(DIAGNOSTIC_COLLECT_SPAN_MS).toBe(87_000_000);
    expect(DIAGNOSTIC_COLLECT_SPAN_MS).toBe(
      DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS + DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS,
    );
  });

  it("publishes the neutral schemas from the shared package barrel", () => {
    expect(Shared.DiagnosticReportIdSchema).toBe(DiagnosticReportIdSchema);
    expect(Shared.DiagnosticReportCreateRequestSchema).toBe(DiagnosticReportCreateRequestSchema);
    expect(Shared.DiagnosticCollectPayloadSchema).toBe(DiagnosticCollectPayloadSchema);
    expect(Shared.DiagnosticCollectCommandSchema).toBe(DiagnosticCollectCommandSchema);
    expect(Shared.DiagnosticReportFailureCodeSchema).toBe(DiagnosticReportFailureCodeSchema);
    expect(Shared.OwnerDiagnosticReportSchema).toBe(OwnerDiagnosticReportSchema);
    expect(Shared.DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS).toBe(DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS);
    expect(Shared.DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS).toBe(DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS);
    expect(Shared.DIAGNOSTIC_COLLECT_SPAN_MS).toBe(DIAGNOSTIC_COLLECT_SPAN_MS);
    expect(Shared.DIAGNOSTIC_REPORT_FAILURE_CODES).toBe(DIAGNOSTIC_REPORT_FAILURE_CODES);
  });

  it("re-exports the database-owned failure-code tuple without copying it", () => {
    expect(DIAGNOSTIC_REPORT_FAILURE_CODES).toBe(DB_FAILURE_CODES);
    expect(DiagnosticReportFailureCodeSchema.options).toEqual([...DB_FAILURE_CODES]);
    expectTypeOf<DiagnosticReportFailureCode>().toEqualTypeOf<(typeof DB_FAILURE_CODES)[number]>();
    expectTypeOf<BarrelDiagnosticReportFailureCode>().toEqualTypeOf<DiagnosticReportFailureCode>();
  });
});

describe("diagnostic ids and owner create request", () => {
  it.each([
    "dbr_a",
    "dbr_0123456789abcdef",
    "dbr_A-Z_09",
  ])("accepts safe report id %s", (reportId) => {
    expect(DiagnosticReportIdSchema.safeParse(reportId).success).toBe(true);
  });

  it.each([
    "dbr_",
    "dbr_../secret",
    "report_0123456789abcdef",
    "dbr_has space",
  ])("rejects unsafe report id %s", (reportId) => {
    expect(DiagnosticReportIdSchema.safeParse(reportId).success).toBe(false);
  });

  it("matches the D1 nonce constraint and rejects unknown create fields", () => {
    for (const clientNonce of ["a".repeat(16), NONCE, "A0_-".repeat(16)]) {
      expect(DiagnosticReportCreateRequestSchema.safeParse({ clientNonce }).success).toBe(true);
    }
    for (const clientNonce of ["a".repeat(15), "a".repeat(65), "unsafe.nonce_1234", "unsafe nonce_1234"]) {
      expect(DiagnosticReportCreateRequestSchema.safeParse({ clientNonce }).success).toBe(false);
    }
    expect(DiagnosticReportCreateRequestSchema.safeParse({
      clientNonce: NONCE,
      machineId: "cm_injected",
    }).success).toBe(false);
  });
});

describe("diagnostics:collect strict wire schema", () => {
  it("accepts only the narrow payload before the command is constructed", () => {
    const { type: _type, ...payload } = valid;
    expect(DiagnosticCollectPayloadSchema.safeParse(payload)).toEqual({
      success: true,
      data: payload,
    });
    expect(DiagnosticCollectPayloadSchema.safeParse({ ...payload, type: valid.type }).success).toBe(false);
    expect(DiagnosticCollectPayloadSchema.safeParse({ ...payload, machineId: "cm_injected" }).success).toBe(false);
  });

  it("accepts the exact frozen command without dropping a field", () => {
    const parsed = DiagnosticCollectCommandSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(valid);
  });

  it("reuses the exact diagnostics command schema in HostCommandSchema", () => {
    expect(HostCommandSchema.options).toContain(DiagnosticCollectCommandSchema);
    expect(HostCommandSchema.safeParse(valid)).toEqual(
      DiagnosticCollectCommandSchema.safeParse(valid),
    );
  });

  it.each([
    ["missing reportId", { ...valid, reportId: undefined }],
    ["path-like reportId", { ...valid, reportId: "dbr_../secret" }],
    ["wrong report prefix", { ...valid, reportId: "report_0123456789abcdef" }],
    ["empty agentId", { ...valid, agentId: "" }],
    ["fractional fromMs", { ...valid, fromMs: FROM_MS + 0.5 }],
    ["negative fromMs", { ...valid, fromMs: -1 }],
    ["unsafe fromMs", { ...valid, fromMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional deadlineAt", { ...valid, deadlineAt: DEADLINE_AT + 0.5 }],
    ["unsafe deadlineAt", { ...valid, deadlineAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["reversed window", { ...valid, deadlineAt: FROM_MS }],
    ["underlong v1 window", { ...valid, deadlineAt: DEADLINE_AT - 1 }],
    ["overlong window", { ...valid, deadlineAt: DEADLINE_AT + 1 }],
    ["unknown top-level key", { ...valid, machineId: "cm_injected" }],
  ])("rejects %s", (_label, command) => {
    expect(DiagnosticCollectCommandSchema.safeParse(command).success).toBe(false);
    expect(HostCommandSchema.safeParse(command).success).toBe(false);
  });
});

describe("owner-safe diagnostic report projection", () => {
  const ownerReport = {
    reportId: valid.reportId,
    status: "pending",
    deadlineAt: valid.deadlineAt,
    completedAt: null,
    failureCode: null,
    objectExpired: false,
  } as const;

  it.each([
    ["pending", ownerReport],
    ["uploaded", { ...ownerReport, status: "uploaded", completedAt: FROM_MS }],
    ["failed", {
      ...ownerReport,
      status: "failed",
      completedAt: FROM_MS,
      failureCode: "offline",
    }],
  ])("accepts exactly the six public fields for %s", (_label, report) => {
    const parsed = OwnerDiagnosticReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(report);
    expect(Object.keys(ownerReport)).toHaveLength(6);
  });

  it.each([
    ["pending with completion", { ...ownerReport, completedAt: FROM_MS }],
    ["pending with failure", { ...ownerReport, failureCode: "offline" }],
    ["pending marked object-expired", { ...ownerReport, objectExpired: true }],
    ["uploaded without completion", { ...ownerReport, status: "uploaded" }],
    ["uploaded with failure", {
      ...ownerReport,
      status: "uploaded",
      completedAt: FROM_MS,
      failureCode: "offline",
    }],
    ["failed without completion or failure", { ...ownerReport, status: "failed" }],
    ["failed with unknown failure", {
      ...ownerReport,
      status: "failed",
      completedAt: FROM_MS,
      failureCode: "private_failure",
    }],
    ["failed marked object-expired", {
      ...ownerReport,
      status: "failed",
      completedAt: FROM_MS,
      failureCode: "offline",
      objectExpired: true,
    }],
    ["terminal fractional completion", {
      ...ownerReport,
      status: "failed",
      completedAt: FROM_MS + 0.5,
      failureCode: "offline",
    }],
    ["terminal negative completion", {
      ...ownerReport,
      status: "failed",
      completedAt: -1,
      failureCode: "offline",
    }],
    ["terminal unsafe completion", {
      ...ownerReport,
      status: "failed",
      completedAt: Number.MAX_SAFE_INTEGER + 1,
      failureCode: "offline",
    }],
  ])("rejects %s", (_label, report) => {
    expect(OwnerDiagnosticReportSchema.safeParse(report).success).toBe(false);
  });

  it.each([
    ["machineId", "cm_private"],
    ["r2Key", "bug-reports/private.ndjson.gz"],
    ["sha256", "a".repeat(64)],
    ["sizeBytes", 123],
    ["fromMs", FROM_MS],
  ])("rejects private field %s", (key, value) => {
    expect(OwnerDiagnosticReportSchema.safeParse({ ...ownerReport, [key]: value }).success).toBe(false);
  });
});
