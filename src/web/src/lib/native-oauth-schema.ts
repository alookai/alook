import { isSafeRedirectPath } from "@alook/shared"
import { z } from "zod"

export const nativeOauthSnapshotSchema = z.object({
  attemptId: z.string(),
  provider: z.enum(["github", "google"]),
  redirectPath: z.string().refine(isSafeRedirectPath),
  expiresAt: z.number(),
  waiting: z.boolean(),
}).strict()

export type NativeOauthSnapshot = z.infer<typeof nativeOauthSnapshotSchema>
