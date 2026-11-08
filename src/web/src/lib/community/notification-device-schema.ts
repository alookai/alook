import { z } from "zod";

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const notificationDeviceInstallationIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(INSTALLATION_ID_PATTERN, "invalid installation id");

export const notificationDeviceRegistrationSchema = z
  .object({
    installationId: notificationDeviceInstallationIdSchema,
    platform: z.enum(["ios", "android"]),
    providerEnvironment: z.enum(["sandbox", "production"]),
    providerToken: z.string().min(16).max(4096),
    previousProviderToken: z.string().min(16).max(4096).optional(),
    appVersion: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    ({ platform, providerEnvironment }) =>
      platform === "ios" || providerEnvironment === "production",
    {
      path: ["providerEnvironment"],
      message: "Android devices require the production environment",
    },
  );

export async function hashProviderToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
