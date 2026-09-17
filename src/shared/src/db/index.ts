import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import * as communitySchema from "./community-schema";
import * as communityMachineSchema from "./community-machine-schema";
import * as billingSchema from "./billing-schema";
import * as productPlanSchema from "./product-plan-schema";
import * as communityFunnelAnalyticsSchema from "./community-funnel-analytics-schema";

const allSchema = { ...schema, ...communitySchema, ...communityMachineSchema, ...productPlanSchema, ...billingSchema, ...communityFunnelAnalyticsSchema };

export function createDb(d1: AnyD1Database) {
  return drizzle(d1, { schema: allSchema });
}

export type Database = ReturnType<typeof createDb>;

export { withD1Retry, readOrStale, isRetryableD1Error } from "./resilience";
export type { RetryOpts } from "./resilience";
