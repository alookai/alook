import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
  communityBotBinding,
  communityDiagnosticReport,
  type DiagnosticReportFailureCode,
} from "../../community-machine-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import {
  DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS,
  DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS,
} from "../../../diagnostics-contract";

const OBJECT_RETENTION_MS = 604_800_000;
const diagnosticOwner = alias(user, "diagnostic_owner");

export type DiagnosticReportRow = typeof communityDiagnosticReport.$inferSelect;

export class DiagnosticReportTargetUnavailableError extends Error {
  readonly code = "DIAGNOSTIC_TARGET_UNAVAILABLE" as const;

  constructor() {
    super("diagnostic report target is unavailable");
    this.name = "DiagnosticReportTargetUnavailableError";
  }
}

type CreateDiagnosticReportInput = {
  ownerUserId: string;
  agentId: string;
  clientNonce: string;
  nowMs: number;
};

export type CreateDiagnosticReportResult =
  | { kind: "created"; report: DiagnosticReportRow }
  | { kind: "same_nonce"; report: DiagnosticReportRow }
  | { kind: "existing_pending"; report: DiagnosticReportRow }
  | { kind: "rate_limited"; report: DiagnosticReportRow };

type ConflictClassification = CreateDiagnosticReportResult | null;

function assertSafeEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("nowMs must be a non-negative safe integer");
  }
}

/**
 * Atomically snapshots owner, live bot, and binding into a pending report.
 * Constants are bound by Drizzle; machine_id comes only from the joined live
 * binding inside this INSERT statement, never from caller-controlled data.
 */
async function tryInsertPendingDiagnosticReport(
  db: Database,
  input: CreateDiagnosticReportInput,
  reportId: string
): Promise<DiagnosticReportRow | null> {
  const fromMs = input.nowMs - DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS;
  const deadlineAt = input.nowMs + DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS;
  const rateBucket = Math.floor(input.nowMs / 60_000);

  const liveTarget = db
    .select({
      id: sql<string>`${reportId}`.as("id"),
      ownerUserId: diagnosticOwner.id,
      agentId: user.id,
      machineId: communityBotBinding.machineId,
      clientNonce: sql<string>`${input.clientNonce}`.as("client_nonce"),
      rateBucket: sql<number>`${rateBucket}`.as("rate_bucket"),
      status: sql<"pending">`'pending'`.as("status"),
      failureCode: sql<null>`NULL`.as("failure_code"),
      fromMs: sql<number>`${fromMs}`.as("from_ms"),
      createdAt: sql<number>`${input.nowMs}`.as("created_at"),
      deadlineAt: sql<number>`${deadlineAt}`.as("deadline_at"),
      completedAt: sql<null>`NULL`.as("completed_at"),
      r2Key: sql<null>`NULL`.as("r2_key"),
      sha256: sql<null>`NULL`.as("sha256"),
      sizeBytes: sql<null>`NULL`.as("size_bytes"),
      uploadedAt: sql<null>`NULL`.as("uploaded_at"),
      objectExpiresAt: sql<null>`NULL`.as("object_expires_at"),
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .innerJoin(diagnosticOwner, eq(diagnosticOwner.id, user.ownerUserId))
    .where(
      and(
        eq(user.id, input.agentId),
        eq(user.ownerUserId, input.ownerUserId),
        eq(user.isBot, true),
        isNull(user.deletedAt),
        isNull(diagnosticOwner.deletedAt)
      )
    );

  const rows = await db
    .insert(communityDiagnosticReport)
    .select(liveTarget)
    .onConflictDoNothing()
    .returning();

  return rows[0] ?? null;
}

async function firstReport(
  query: PromiseLike<DiagnosticReportRow[]>
): Promise<DiagnosticReportRow | null> {
  const rows = await query;
  return rows[0] ?? null;
}

async function classifyCreateConflict(
  db: Database,
  input: CreateDiagnosticReportInput
): Promise<ConflictClassification> {
  const sameNonce = await firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.ownerUserId, input.ownerUserId),
          eq(communityDiagnosticReport.clientNonce, input.clientNonce)
        )
      )
      .limit(1)
  );
  if (sameNonce) {
    if (sameNonce.status === "pending" && sameNonce.deadlineAt <= input.nowMs) {
      const timedOut = await timeoutPendingDiagnosticReport(db, {
        reportId: sameNonce.id,
        ownerUserId: input.ownerUserId,
        nowMs: input.nowMs,
      });
      if (timedOut) return { kind: "same_nonce", report: timedOut };

      // A concurrent terminal writer may have beaten the timeout CAS. Preserve
      // the nonce's authoritative identity instead of creating a replacement.
      const winner = await firstReport(
        db
          .select()
          .from(communityDiagnosticReport)
          .where(
            and(
              eq(communityDiagnosticReport.ownerUserId, input.ownerUserId),
              eq(communityDiagnosticReport.clientNonce, input.clientNonce)
            )
          )
          .limit(1)
      );
      if (winner) return { kind: "same_nonce", report: winner };
    } else {
      return { kind: "same_nonce", report: sameNonce };
    }
  }

  const existingPending = await firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.ownerUserId, input.ownerUserId),
          eq(communityDiagnosticReport.agentId, input.agentId),
          eq(communityDiagnosticReport.status, "pending")
        )
      )
      .limit(1)
  );
  if (existingPending) {
    if (existingPending.deadlineAt > input.nowMs) {
      return { kind: "existing_pending", report: existingPending };
    }
    const timedOut = await timeoutPendingDiagnosticReport(db, {
      reportId: existingPending.id,
      ownerUserId: input.ownerUserId,
      nowMs: input.nowMs,
    });
    if (!timedOut) {
      const winner = await firstReport(
        db
          .select()
          .from(communityDiagnosticReport)
          .where(
            and(
              eq(communityDiagnosticReport.id, existingPending.id),
              eq(communityDiagnosticReport.ownerUserId, input.ownerUserId)
            )
          )
          .limit(1)
      );
      if (winner?.status === "pending") {
        return { kind: "existing_pending", report: winner };
      }
    }
  }

  const rateLimited = await firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.ownerUserId, input.ownerUserId),
          eq(communityDiagnosticReport.rateBucket, Math.floor(input.nowMs / 60_000))
        )
      )
      .limit(1)
  );
  return rateLimited ? { kind: "rate_limited", report: rateLimited } : null;
}

export async function createOrGetPendingDiagnosticReport(
  db: Database,
  input: CreateDiagnosticReportInput
): Promise<CreateDiagnosticReportResult> {
  assertSafeEpoch(input.nowMs);
  if (input.nowMs < DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS) {
    throw new RangeError("nowMs is too early for the diagnostic collection window");
  }
  if (!Number.isSafeInteger(input.nowMs + DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS)) {
    throw new RangeError("diagnostic deadline exceeds the safe integer range");
  }

  const reportId = `dbr_${nanoid()}`;
  const inserted = await tryInsertPendingDiagnosticReport(db, input, reportId);
  if (inserted) return { kind: "created", report: inserted };

  const conflict = await classifyCreateConflict(db, input);
  if (conflict) return conflict;

  // A pending conflict winner may terminalize between the failed insert and
  // classification. Retry exactly once; a second zero-row result fails closed
  // because the live bot/binding snapshot may also have disappeared.
  const retried = await tryInsertPendingDiagnosticReport(db, input, reportId);
  if (retried) return { kind: "created", report: retried };
  const retryConflict = await classifyCreateConflict(db, input);
  if (retryConflict) return retryConflict;
  throw new DiagnosticReportTargetUnavailableError();
}

export async function getDiagnosticReportForOwner(
  db: Database,
  input: { reportId: string; ownerUserId: string }
): Promise<DiagnosticReportRow | null> {
  return firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.id, input.reportId),
          eq(communityDiagnosticReport.ownerUserId, input.ownerUserId)
        )
      )
      .limit(1)
  );
}

export async function getPendingDiagnosticReportForMachine(
  db: Database,
  input: { reportId: string; machineId: string; nowMs: number }
): Promise<DiagnosticReportRow | null> {
  assertSafeEpoch(input.nowMs);
  return firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.id, input.reportId),
          eq(communityDiagnosticReport.machineId, input.machineId),
          eq(communityDiagnosticReport.status, "pending"),
          gt(communityDiagnosticReport.deadlineAt, input.nowMs)
        )
      )
      .limit(1)
  );
}

export async function getDiagnosticReportForMachine(
  db: Database,
  input: { reportId: string; machineId: string }
): Promise<DiagnosticReportRow | null> {
  return firstReport(
    db
      .select()
      .from(communityDiagnosticReport)
      .where(
        and(
          eq(communityDiagnosticReport.id, input.reportId),
          eq(communityDiagnosticReport.machineId, input.machineId)
        )
      )
      .limit(1)
  );
}

export async function timeoutPendingDiagnosticReport(
  db: Database,
  input: { reportId: string; ownerUserId: string; nowMs: number }
): Promise<DiagnosticReportRow | null> {
  assertSafeEpoch(input.nowMs);
  const rows = await db
    .update(communityDiagnosticReport)
    .set({ status: "failed", failureCode: "timeout", completedAt: input.nowMs })
    .where(
      and(
        eq(communityDiagnosticReport.id, input.reportId),
        eq(communityDiagnosticReport.ownerUserId, input.ownerUserId),
        eq(communityDiagnosticReport.status, "pending"),
        lte(communityDiagnosticReport.deadlineAt, input.nowMs)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function failPendingDiagnosticReport(
  db: Database,
  input: {
    reportId: string;
    machineId: string;
    failureCode: DiagnosticReportFailureCode;
    nowMs: number;
  }
): Promise<DiagnosticReportRow | null> {
  assertSafeEpoch(input.nowMs);
  const rows = await db
    .update(communityDiagnosticReport)
    .set({
      status: "failed",
      failureCode: input.failureCode,
      completedAt: input.nowMs,
    })
    .where(
      and(
        eq(communityDiagnosticReport.id, input.reportId),
        eq(communityDiagnosticReport.machineId, input.machineId),
        eq(communityDiagnosticReport.status, "pending"),
        gt(communityDiagnosticReport.deadlineAt, input.nowMs)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function finalizeDiagnosticReportUpload(
  db: Database,
  input: {
    reportId: string;
    machineId: string;
    r2Key: string;
    sha256: string;
    sizeBytes: number;
    nowMs: number;
  }
): Promise<DiagnosticReportRow | null> {
  assertSafeEpoch(input.nowMs);
  if (!Number.isSafeInteger(input.nowMs + OBJECT_RETENTION_MS)) {
    throw new RangeError("diagnostic object expiry exceeds the safe integer range");
  }
  const rows = await db
    .update(communityDiagnosticReport)
    .set({
      status: "uploaded",
      failureCode: null,
      completedAt: input.nowMs,
      r2Key: input.r2Key,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      uploadedAt: input.nowMs,
      objectExpiresAt: input.nowMs + OBJECT_RETENTION_MS,
    })
    .where(
      and(
        eq(communityDiagnosticReport.id, input.reportId),
        eq(communityDiagnosticReport.machineId, input.machineId),
        eq(communityDiagnosticReport.status, "pending"),
        gt(communityDiagnosticReport.deadlineAt, input.nowMs)
      )
    )
    .returning();
  return rows[0] ?? null;
}

type ExpectedTerminal =
  | { status: "uploaded"; r2Key: string; sha256: string; sizeBytes: number }
  | { status: "failed"; failureCode: DiagnosticReportFailureCode };

export function classifyDiagnosticReportTerminal(
  report: Pick<
    DiagnosticReportRow,
    "status" | "failureCode" | "r2Key" | "sha256" | "sizeBytes"
  >,
  expected: ExpectedTerminal
):
  | { kind: "pending" }
  | { kind: "uploaded_same" }
  | { kind: "uploaded_different" }
  | { kind: "failed_same" }
  | { kind: "failed_different" } {
  if (report.status === "pending") return { kind: "pending" };
  if (report.status === "failed") {
    return expected.status === "failed" && report.failureCode === expected.failureCode
      ? { kind: "failed_same" }
      : { kind: "failed_different" };
  }
  if (
    expected.status === "uploaded" &&
    report.r2Key === expected.r2Key &&
    report.sha256 === expected.sha256 &&
    report.sizeBytes === expected.sizeBytes
  ) {
    return { kind: "uploaded_same" };
  }
  return { kind: "uploaded_different" };
}
