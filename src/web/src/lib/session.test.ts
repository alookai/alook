import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({ api: { getSession: mockGetSession } })),
}));

import { getSession, requireSession } from "./session";

describe("session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getSession returns the resolved session", async () => {
    const session = { user: { id: "u1", email: "u@t.com" } };
    mockGetSession.mockResolvedValue(session);
    await expect(getSession()).resolves.toEqual(session);
  });

  it("getSession returns null when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(getSession()).resolves.toBeNull();
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
