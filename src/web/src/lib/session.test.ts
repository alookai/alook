import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}));

const mockHeaders = vi.hoisted(() => vi.fn(async () => new Headers()));
vi.mock("next/headers", () => ({ headers: mockHeaders }));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(() => ({ api: { getSession: mockGetSession } })),
}));

import { getSession, requireSession } from "./session";

describe("session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
  });

  it("getSession returns the resolved session", async () => {
    const session = { user: { id: "u1", email: "u@t.com" } };
    mockGetSession.mockResolvedValue(session);
    await expect(getSession()).resolves.toEqual(session);
  });

  it("getSession returns null when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(getSession()).resolves.toBeNull();
  });

  it("resolves concurrent users independently through the shared auth instance", async () => {
    mockHeaders
      .mockResolvedValueOnce(new Headers({ Cookie: "viewer=user-a" }))
      .mockResolvedValueOnce(new Headers({ Cookie: "viewer=user-b" }));
    mockGetSession.mockImplementation(async ({ headers }: { headers: Headers }) => ({
      user: { id: headers.get("Cookie")?.split("=")[1] },
    }));

    const [first, second] = await Promise.all([getSession(), getSession()]);

    expect(first?.user.id).toBe("user-a");
    expect(second?.user.id).toBe("user-b");
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it("requireSession returns the session when present", async () => {
    const session = { user: { id: "u1", email: "u@t.com" } };
    mockGetSession.mockResolvedValue(session);
    await expect(requireSession()).resolves.toEqual(session);
  });

  it("requireSession throws Unauthorized when session is absent", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(requireSession()).rejects.toThrow("Unauthorized");
  });
});
