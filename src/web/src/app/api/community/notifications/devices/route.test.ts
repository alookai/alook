import { decrypt } from "@alook/shared/crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { primary: true },
  registerPushDevice: vi.fn(),
  withCookieHumanAuth: vi.fn(
    (handler: (req: NextRequest, ctx: Record<string, unknown>) => Promise<Response>) =>
      async (req: NextRequest) => handler(req, {
        env: {
          DB: {},
          ENCRYPTION_KEY: "fake-encryption-key",
        },
        userId: "session-user",
        email: "session@example.test",
      }),
  ),
}));

vi.mock("@/lib/db", () => ({
  getPrimaryDb: vi.fn(() => mocks.db),
}));

vi.mock("@alook/shared", () => ({
  queries: {
    communityPushDevice: {
      registerPushDevice: (...args: unknown[]) =>
        mocks.registerPushDevice(...args),
    },
  },
}));

vi.mock("@/lib/middleware/auth", () => ({
  withCookieHumanAuth: mocks.withCookieHumanAuth,
}));

import { POST } from "./route";

const cookieHumanHandler = mocks.withCookieHumanAuth.mock.calls[0]![0] as (
  req: NextRequest,
  ctx: Record<string, unknown>,
) => Promise<Response>;

const token = "fake-provider-token-123";
const previousToken = "fake-previous-token-123";

function request(body: string, headers: Record<string, string> = {}) {
  return new NextRequest(
    "https://alook.ai/api/community/notifications/devices",
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://alook.ai",
        ...headers,
      },
    },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    installationId: "installation-123",
    platform: "ios",
    providerEnvironment: "sandbox",
    providerToken: token,
    previousProviderToken: previousToken,
    appVersion: "1.2.3",
    ...overrides,
  });
}

describe("POST /api/community/notifications/devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    mocks.registerPushDevice.mockResolvedValue({
      ok: true,
      device: {
        installationId: "installation-123",
        platform: "ios",
        providerEnvironment: "sandbox",
        appVersion: "1.2.3",
        lastSeenAt: "2026-09-12T00:00:00.000Z",
        disabledAt: null,
      },
    });
  });

  it("is defined through the cookie-human-only authentication boundary", () => {
    expect(cookieHumanHandler).toEqual(expect.any(Function));
  });

  it("derives identity, hashes, ciphertext, and timestamps on the server", async () => {
    const response = await POST(request(validBody()));

    expect(response.status).toBe(200);
    expect(mocks.registerPushDevice).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        userId: "session-user",
        installationId: "installation-123",
        platform: "ios",
        providerEnvironment: "sandbox",
        providerTokenHash:
          "04e7ad517a6cc23fa2c94e37eee8c98fefb772de5d84f73b180c0d344d7c59ac",
        previousProviderTokenHash:
          "6441899ba9e50e8a754691bcd032064634566723d6dcbb5c834fbcfabc4be0dd",
        appVersion: "1.2.3",
        now: "2026-09-12T00:00:00.000Z",
      }),
    );
    const input = mocks.registerPushDevice.mock.calls[0]![1] as {
      providerTokenEncrypted: string;
    };
    expect(input.providerTokenEncrypted).not.toContain(token);
    expect(decrypt(
      input.providerTokenEncrypted,
      "fake-encryption-key",
    )).toBe(token);

    const responseText = await response.text();
    expect(responseText).not.toContain(token);
    expect(responseText).not.toContain(previousToken);
    expect(responseText).not.toContain("fake-encryption-key");
    expect(responseText).not.toContain("04e7ad51");
  });

  it("omits the previous-token proof when the client has no previous token", async () => {
    const response = await POST(request(validBody({ previousProviderToken: undefined })));

    expect(response.status).toBe(200);
    expect(mocks.registerPushDevice).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({ previousProviderTokenHash: undefined }),
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown user id", validBody({ userId: "other-user" })],
    ["client hash", validBody({ providerTokenHash: "a".repeat(64) })],
    ["invalid Android environment", validBody({
      platform: "android",
      providerEnvironment: "sandbox",
    })],
  ])("rejects %s before persistence", async (_name, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.registerPushDevice).not.toHaveBeenCalled();
  });

  it("fails closed when encryption is not configured", async () => {
    const response = await cookieHumanHandler(request(validBody()), {
      env: { DB: {}, ENCRYPTION_KEY: "" },
      userId: "session-user",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "encryption not configured" });
    expect(mocks.registerPushDevice).not.toHaveBeenCalled();
  });

  it("returns a secret-free conflict without logging", async () => {
    mocks.registerPushDevice.mockResolvedValue({
      ok: false,
      reason: "ownership-conflict",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request(validBody()));
    const responseText = await response.text();

    expect(response.status).toBe(409);
    expect(responseText).toBe('{"error":"device ownership conflict"}');
    expect(responseText).not.toContain(token);
    expect(responseText).not.toContain(previousToken);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
