import { z } from "zod";
import { isSafeRedirectPath } from "./safe-redirect";

const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{32,128}$/;

export const nativeOauthProviderSchema = z.enum(["github", "google"]);
export const nativeOauthPlatformSchema = z.enum([
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
]);
export const nativeOauthAttemptIdSchema = z.string().regex(ATTEMPT_ID);
export const nativeOauthHandoffCodeSchema = z.string().regex(HANDOFF_CODE);
export const nativeOauthFailureCodeSchema = z.enum([
  "access_denied",
  "provider_error",
  "oauth_callback_failed",
  "start_failed",
  "invalid_handoff",
]);

export type NativeOauthProvider = z.infer<typeof nativeOauthProviderSchema>;
export type NativeOauthPlatform = z.infer<typeof nativeOauthPlatformSchema>;
export type NativeOauthFailureCode = z.infer<
  typeof nativeOauthFailureCodeSchema
>;

export const nativeOauthRegistrationSchema = z.object({
  attemptId: nativeOauthAttemptIdSchema,
  stateHash: z.string().regex(SHA256_HEX),
  codeChallenge: z.string().regex(BASE64URL_32_BYTES),
  instanceKeyHash: z.string().regex(SHA256_HEX),
  platform: nativeOauthPlatformSchema,
  provider: nativeOauthProviderSchema,
  redirectPath: z.string().refine(isSafeRedirectPath),
}).strict();

export const nativeOauthExchangeSchema = z.object({
  attemptId: nativeOauthAttemptIdSchema,
  state: z.string().regex(BASE64URL_32_BYTES),
  verifier: z.string().regex(BASE64URL_32_BYTES),
  code: nativeOauthHandoffCodeSchema,
}).strict();

export const nativeOauthProofSchema = nativeOauthExchangeSchema
  .omit({ code: true })
  .strict();
