import { z } from "zod";

const identity = z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/);

export const AgentModelReportSchema = z.object({
  agentId: z.string().min(1),
  backendId: z.string().min(1).max(100),
  sessionInstanceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
  launchId: z.string().min(1).max(128).optional(),
  model: identity,
  provider: identity.optional(),
  source: z.enum(["response", "session"]),
  responseId: identity.optional(),
  observedAt: z.string().datetime({ offset: true }),
});

export type AgentModelReport = z.infer<typeof AgentModelReportSchema>;
export type StoredModelObservation = AgentModelReport & { machineId: string };
export const AgentModelMessageSchema = AgentModelReportSchema.extend({ type: z.literal("agent_model") });
