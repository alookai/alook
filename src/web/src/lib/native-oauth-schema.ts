import { isSafeRedirectPath, nativeOauthProviderSchema } from "@alook/shared"
import { z } from "zod"

export const nativeOauthSnapshotSchema = z.object({
  attemptId: z.string(),
  provider: nativeOauthProviderSchema,
  redirectPath: z.string().refine(isSafeRedirectPath),
  expiresAt: z.number(),
  waiting: z.boolean(),
}).strict()

export type NativeOauthSnapshot = z.infer<typeof nativeOauthSnapshotSchema>
