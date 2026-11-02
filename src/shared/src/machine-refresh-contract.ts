import { z } from "zod";

export const MACHINE_REFRESH_CAPABILITY = "machineRefresh";
export const MachineRefreshRequestIdSchema = z.uuid();
export const MachineRefreshRequestSchema = z.strictObject({ requestId: MachineRefreshRequestIdSchema });
export const MachineRefreshCommandSchema = z.strictObject({
  type: z.literal("machine:refresh"),
  requestId: MachineRefreshRequestIdSchema,
});
export const MachineRefreshResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ requestId: MachineRefreshRequestIdSchema, status: z.literal("complete") }),
  z.strictObject({
    requestId: MachineRefreshRequestIdSchema,
    status: z.literal("error"),
    code: z.enum(["environment_unavailable", "refresh_in_progress", "restart_failed", "ownership_changed"]),
  }),
]);
export type MachineRefreshResult = z.infer<typeof MachineRefreshResultSchema>;
