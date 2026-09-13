import { describe, expect, it } from "vitest";
import {
  hashProviderToken,
  isCookieHumanSameOrigin,
  notificationDeviceInstallationIdSchema,
  notificationDeviceRegistrationSchema,
} from "./notification-device-schema";

function registration(overrides: Record<string, unknown> = {}) {
  return {
    installationId: "installation-123",
    platform: "ios",
    providerEnvironment: "sandbox",
    providerToken: "fake-provider-token-123",
    appVersion: "1.2.3",
    ...overrides,
  };
}

describe("notification device registration schema", () => {
  it("accepts supported iOS and Android provider environments", () => {
    expect(notificationDeviceRegistrationSchema.safeParse(registration()).success)
      .toBe(true);
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      platform: "ios",
      providerEnvironment: "production",
    })).success).toBe(true);
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      platform: "android",
      providerEnvironment: "production",
    })).success).toBe(true);
  });

  it("rejects unsupported platform/environment pairs and client-owned fields", () => {
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      platform: "android",
      providerEnvironment: "sandbox",
    })).success).toBe(false);
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      platform: "web",
    })).success).toBe(false);

    for (const extra of [
      { userId: "other-user" },
      { providerTokenHash: "a".repeat(64) },
      { providerTokenEncrypted: "client-ciphertext" },
      { disabledAt: null },
    ]) {
      expect(notificationDeviceRegistrationSchema.safeParse(
        registration(extra),
      ).success).toBe(false);
    }
  });

  it("bounds every opaque client value and rejects empty or wrong types", () => {
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      installationId: "a".repeat(7),
    })).success).toBe(false);
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      installationId: "a".repeat(129),
    })).success).toBe(false);
    expect(notificationDeviceRegistrationSchema.safeParse(registration({
      installationId: "unsafe value",
    })).success).toBe(false);
    expect(notificationDeviceInstallationIdSchema.safeParse(
      "safe:installation_123",
    ).success).toBe(true);

    for (const invalid of [
      { providerToken: "short" },
      { providerToken: "a".repeat(4097) },
      { previousProviderToken: "short" },
      { previousProviderToken: "a".repeat(4097) },
      { appVersion: "" },
      { appVersion: "a".repeat(129) },
      { appVersion: null },
      { installationId: null },
      { providerToken: 123 },
    ]) {
      expect(notificationDeviceRegistrationSchema.safeParse(
        registration(invalid),
      ).success).toBe(false);
    }
  });

  it("hashes provider tokens deterministically with lowercase SHA-256", async () => {
    await expect(hashProviderToken("fake-provider-token-123")).resolves.toBe(
      "04e7ad517a6cc23fa2c94e37eee8c98fefb772de5d84f73b180c0d344d7c59ac",
    );
    await expect(hashProviderToken("fake-provider-token-456")).resolves.not.toBe(
      "04e7ad517a6cc23fa2c94e37eee8c98fefb772de5d84f73b180c0d344d7c59ac",
    );
  });
});

describe("notification device same-origin gate", () => {
  it("accepts the exact origin and matching loopback host", () => {
    expect(isCookieHumanSameOrigin(new Request(
      "https://alook.ai/api/community/notifications/devices",
      { headers: { Origin: "https://alook.ai" } },
    ))).toBe(true);
    expect(isCookieHumanSameOrigin(new Request(
      "http://127.0.0.1:3001/api/community/notifications/devices",
      {
        headers: {
          Host: "localhost:3001",
          Origin: "http://localhost:3001",
        },
      },
    ))).toBe(true);
  });

  it("rejects missing, malformed, or cross-origin requests", () => {
    expect(isCookieHumanSameOrigin(new Request(
      "https://alook.ai/api/community/notifications/devices",
    ))).toBe(false);
    expect(isCookieHumanSameOrigin(new Request(
      "https://alook.ai/api/community/notifications/devices",
      { headers: { Origin: "not-an-origin" } },
    ))).toBe(false);
    expect(isCookieHumanSameOrigin(new Request(
      "https://alook.ai/api/community/notifications/devices",
      { headers: { Origin: "https://evil.example" } },
    ))).toBe(false);
  });
});
