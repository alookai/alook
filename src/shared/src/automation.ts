import { z } from "zod"

export const AUTOMATION_WRITE_PERMISSIONS = ["bot.create", "server.create", "server.invite"] as const
export const AUTOMATION_READ_PERMISSIONS = ["machine.read", "friend.read", "server.read"] as const
export const AutomationPermissionSchema = z.enum([...AUTOMATION_WRITE_PERMISSIONS, ...AUTOMATION_READ_PERMISSIONS])
export const AutomationExpirySchema = z.enum(["1h", "24h", "7d", "30d", "forever"])
export const AutomationPermissionPolicySchema = z.strictObject({
  permission: AutomationPermissionSchema,
  limit: z.number().int().positive(),
  period: z.enum(["hour", "day"]),
}).refine((value) => value.limit <= (value.period === "hour" ? 64 : 1536), {
  message: "Limit cannot exceed 64/hour or 1536/day", path: ["limit"],
})
const permissions = z.array(AutomationPermissionPolicySchema).min(1).max(6)
  .refine((values) => new Set(values.map((value) => value.permission)).size === values.length, "Duplicate permission")
export const AutomationAccessCodeCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  expiresIn: AutomationExpirySchema.default("24h"),
  permissions,
})
export const AutomationAccessCodeUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  expiresIn: AutomationExpirySchema.optional(),
  permissions: permissions.optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one change")

export type AutomationPermission = z.infer<typeof AutomationPermissionSchema>
export type AutomationPermissionPolicy = z.infer<typeof AutomationPermissionPolicySchema>
export type AutomationExpiry = z.infer<typeof AutomationExpirySchema>
export type AutomationAccessCodeCreate = z.infer<typeof AutomationAccessCodeCreateSchema>
export type AutomationAccessCodeUpdate = z.infer<typeof AutomationAccessCodeUpdateSchema>
export interface AutomationAccessCode {
  id: string
  name: string
  prefix: string
  createdAt: string
  expiresAt: string | null
  permissions: AutomationPermissionPolicy[]
}
export interface AutomationAccessCodeListResponse { accessCodes: AutomationAccessCode[] }
export interface AutomationAccessCodeCreateResponse { accessCode: AutomationAccessCode; secret: string }
export interface AutomationAccessCodeUpdateResponse { accessCode: AutomationAccessCode }

export function automationExpiresAt(expiry: AutomationExpiry, now = Date.now()): string | null {
  const hours = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, forever: null }[expiry]
  return hours === null ? null : new Date(now + hours * 3_600_000).toISOString()
}
