import { z } from "zod";

export const BillingPlanSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
});

export const BillingOfferSchema = z.object({
  priceId: z.string().min(1),
  botLimit: z.number().int().nonnegative(),
  plan: BillingPlanSchema,
  unitAmount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  interval: z.enum(["month", "year", "week", "day"]),
  intervalCount: z.number().int().positive(),
});

export const BillingSubscriptionSchema = z.object({
  plan: BillingPlanSchema,
  status: z.string().min(1),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAt: z.string().datetime().nullable(),
  scheduledChange: z.object({
    plan: BillingPlanSchema,
    effectiveAt: z.string().datetime(),
  }).nullable(),
});

export const PublicPricingSchema = z.object({
  free: z.object({
    plan: BillingPlanSchema,
    botLimit: z.number().int().nonnegative(),
  }),
  offers: z.array(BillingOfferSchema),
});

export const BillingSummarySchema = z.object({
  plan: BillingPlanSchema,
  isFounder: z.boolean(),
  offers: z.array(BillingOfferSchema),
  subscription: BillingSubscriptionSchema.nullable(),
});

export const BillingCheckoutRequestSchema = z.strictObject({
  priceId: z.string().min(1).max(255),
  founderAcknowledged: z.boolean().optional(),
});

export const BillingPortalRequestSchema = z.strictObject({
  priceId: z.string().min(1).max(255).optional(),
});

export const BillingRedirectResponseSchema = z.object({
  url: z.string().url(),
});

export type BillingSummary = z.infer<typeof BillingSummarySchema>;
export type PublicPricing = z.infer<typeof PublicPricingSchema>;
export type BillingOffer = z.infer<typeof BillingOfferSchema>;
export type BillingSubscription = z.infer<typeof BillingSubscriptionSchema>;
export type BillingCheckoutRequest = z.infer<typeof BillingCheckoutRequestSchema>;
export type BillingPortalRequest = z.infer<typeof BillingPortalRequestSchema>;
export type BillingRedirectResponse = z.infer<typeof BillingRedirectResponseSchema>;
