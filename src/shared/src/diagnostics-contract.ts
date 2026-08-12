import { z } from "zod";
import {
  DIAGNOSTIC_REPORT_FAILURE_CODES,
  type DiagnosticReportFailureCode,
} from "./db/community-machine-schema";

export { DIAGNOSTIC_REPORT_FAILURE_CODES };
export type { DiagnosticReportFailureCode };

export const DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS = 86_400_000;
export const DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS = 600_000;
export const DIAGNOSTIC_COLLECT_SPAN_MS =
  DIAGNOSTIC_REPORT_COLLECTION_WINDOW_MS + DIAGNOSTIC_REPORT_DEADLINE_WINDOW_MS;

const SafeEpochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const AgentIdSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);

export const DiagnosticReportIdSchema = z.string().regex(/^dbr_[A-Za-z0-9_-]+$/);
export const DiagnosticReportFailureCodeSchema = z.enum(DIAGNOSTIC_REPORT_FAILURE_CODES);

export const DiagnosticReportCreateRequestSchema = z
  .object({
    clientNonce: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const DiagnosticCollectPayloadSchema = z
  .object({
    reportId: DiagnosticReportIdSchema,
    agentId: AgentIdSchema,
    fromMs: SafeEpochSchema,
    deadlineAt: SafeEpochSchema,
  })
  .strict();

export const DiagnosticCollectCommandSchema = z
  .object({
    type: z.literal("diagnostics:collect"),
    reportId: DiagnosticReportIdSchema,
    agentId: AgentIdSchema,
    fromMs: SafeEpochSchema,
    deadlineAt: SafeEpochSchema,
  })
  .strict()
  .refine(
    (command) => command.deadlineAt - command.fromMs === DIAGNOSTIC_COLLECT_SPAN_MS,
    { message: "diagnostic collection span must match v1" },
  );

const OwnerDiagnosticReportBase = {
  reportId: DiagnosticReportIdSchema,
  deadlineAt: SafeEpochSchema,
} as const;

export const OwnerDiagnosticReportSchema = z.discriminatedUnion("status", [
  z.object({
    ...OwnerDiagnosticReportBase,
    status: z.literal("pending"),
    completedAt: z.null(),
    failureCode: z.null(),
    objectExpired: z.literal(false),
  }).strict(),
  z.object({
    ...OwnerDiagnosticReportBase,
    status: z.literal("uploaded"),
    completedAt: SafeEpochSchema,
    failureCode: z.null(),
    objectExpired: z.boolean(),
  }).strict(),
  z.object({
    ...OwnerDiagnosticReportBase,
    status: z.literal("failed"),
    completedAt: SafeEpochSchema,
    failureCode: DiagnosticReportFailureCodeSchema,
    objectExpired: z.literal(false),
  }).strict(),
]);

export type DiagnosticReportCreateRequest = z.infer<typeof DiagnosticReportCreateRequestSchema>;
export type DiagnosticCollectPayload = z.infer<typeof DiagnosticCollectPayloadSchema>;
export type DiagnosticCollectCommand = z.infer<typeof DiagnosticCollectCommandSchema>;
export type OwnerDiagnosticReport = z.infer<typeof OwnerDiagnosticReportSchema>;
