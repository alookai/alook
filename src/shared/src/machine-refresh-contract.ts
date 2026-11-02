import { z } from "zod";

export const MACHINE_REFRESH_CAPABILITY = "machineRefresh";
export const MachineRefreshCommandSchema = z.strictObject({ type: z.literal("machine:refresh") });
