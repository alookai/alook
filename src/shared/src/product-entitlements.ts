import { z } from "zod";

export type EntitlementValue =
  | null
  | boolean
  | number
  | string
  | EntitlementValue[]
  | { [key: string]: EntitlementValue };

export const EntitlementValueSchema: z.ZodType<EntitlementValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(EntitlementValueSchema),
    z.record(z.string(), EntitlementValueSchema),
  ]),
);

export const NonNegativeIntegerEntitlementSchema = z.number().int().nonnegative();

export const BOTS_MAX_ENTITLEMENT_KEY = "bots.max";

export const CommunityBotActivationRequestSchema = z.strictObject({
  active: z.boolean(),
});

export type CommunityBotActivationRequest = z.infer<
  typeof CommunityBotActivationRequestSchema
>;

export type ResolvedProductPlan = {
  id: string;
  displayName: string;
};

export type BotCapacitySummary = {
  isFounder: boolean;
  plan: ResolvedProductPlan;
  limit: number;
  ownedCount: number;
  activeCount: number;
};
