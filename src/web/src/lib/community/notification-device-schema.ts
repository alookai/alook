import { z } from "zod";

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const notificationDeviceRegistrationSchema = z
  .object({
    installationId: z
      .string()
      .min(8)
      .max(128)
      .regex(INSTALLATION_ID_PATTERN, "invalid installation id"),
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

export const notificationDeviceInstallationIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(INSTALLATION_ID_PATTERN, "invalid installation id");

export async function hashProviderToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function isCookieHumanSameOrigin(req: Request): boolean {
  const originHeader = req.headers.get("Origin");
  if (!originHeader) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  if (originHeader !== originUrl.origin) return false;

  const requestUrl = new URL(req.url);
  if (originUrl.origin === requestUrl.origin) return true;

  return (
    isLoopbackHostname(originUrl.hostname) &&
    isLoopbackHostname(requestUrl.hostname) &&
    req.headers.get("Host") === originUrl.host
  );
}
